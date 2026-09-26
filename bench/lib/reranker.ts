import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Node client for bench/reranker/rerank_server.py — spawns the Python
 * cross-encoder process once, keeps it warm across many rerank() calls (model
 * load dominates any single request), and talks newline-delimited JSON over
 * stdin/stdout. The Python side processes one line at a time in the order
 * received, so this client only needs a FIFO queue, not id-based dispatch.
 *
 * Free of `$lib`/`$env` imports so `bench/` runs under plain `tsx`.
 */

const DEFAULT_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'reranker', 'rerank_server.py');

export interface RerankerOptions {
	device?: 'cuda' | 'cpu';
	dtype?: 'fp16' | 'fp32';
	maxLength?: number;
	batchSize?: number;
	/** Defaults to 'python' — the system Python this project already relies on
	 * (torch/transformers preinstalled; see the bench build brief). */
	pythonPath?: string;
	scriptPath?: string;
	/** How long to wait for the {"ready": true} line before giving up on startup. */
	readyTimeoutMs?: number;
	/** How long to wait for a response to one rerank()/stats() call. */
	requestTimeoutMs?: number;
}

export interface RerankResult {
	scores: number[];
	ms: number;
}

export interface RerankerStats {
	peak_vram_mb: number;
	rss_mb: number;
	device: string;
	dtype: string;
	revision: string;
}

interface PendingEntry {
	resolve: (v: unknown) => void;
	reject: (err: Error) => void;
	timer: ReturnType<typeof setTimeout>;
	kind: 'rerank' | 'stats';
}

const DEFAULT_READY_TIMEOUT_MS = 10 * 60 * 1000; // model download + load can be slow the first time
const DEFAULT_REQUEST_TIMEOUT_MS = 2 * 60 * 1000;

export class RerankerClient {
	private child: ChildProcessWithoutNullStreams | null = null;
	private pending: PendingEntry[] = [];
	private nextId = 1;
	private opts: Required<Pick<RerankerOptions, 'device' | 'dtype' | 'maxLength' | 'batchSize' | 'pythonPath' | 'scriptPath' | 'readyTimeoutMs' | 'requestTimeoutMs'>>;
	private stderrTail: string[] = [];
	public loadMs = 0;

	constructor(opts: RerankerOptions = {}) {
		this.opts = {
			device: opts.device ?? 'cuda',
			dtype: opts.dtype ?? (opts.device === 'cpu' ? 'fp32' : 'fp16'),
			maxLength: opts.maxLength ?? 512,
			batchSize: opts.batchSize ?? 16,
			pythonPath: opts.pythonPath ?? 'python',
			scriptPath: opts.scriptPath ?? DEFAULT_SCRIPT,
			readyTimeoutMs: opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
			requestTimeoutMs: opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
		};
	}

	async start(): Promise<{ loadMs: number }> {
		if (this.child) throw new Error('RerankerClient.start() çağrıldı ama zaten çalışıyor');
		const args = [
			this.opts.scriptPath,
			'--device',
			this.opts.device,
			'--dtype',
			this.opts.dtype,
			'--max-length',
			String(this.opts.maxLength),
			'--batch-size',
			String(this.opts.batchSize)
		];
		const child = spawn(this.opts.pythonPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
		this.child = child;

		child.stderr.on('data', (chunk: Buffer) => {
			const text = chunk.toString('utf-8');
			this.stderrTail.push(text);
			if (this.stderrTail.length > 200) this.stderrTail.shift();
		});

		const rl = createInterface({ input: child.stdout });
		const ready = new Promise<{ loadMs: number }>((resolve, reject) => {
			const timer = setTimeout(() => {
				reject(new Error(`reranker: ready() ${this.opts.readyTimeoutMs}ms içinde gelmedi\n${this.stderrTail.join('')}`));
			}, this.opts.readyTimeoutMs);

			let readyResolved = false;
			rl.on('line', (line: string) => {
				const trimmed = line.trim();
				if (!trimmed) return;
				if (!readyResolved) {
					readyResolved = true;
					clearTimeout(timer);
					try {
						const parsed = JSON.parse(trimmed) as { ready?: boolean; load_ms?: number };
						if (parsed.ready) {
							this.loadMs = parsed.load_ms ?? 0;
							resolve({ loadMs: this.loadMs });
							return;
						}
						reject(new Error(`reranker: ilk satır ready değil: ${trimmed}`));
					} catch (err) {
						reject(new Error(`reranker: ilk satır JSON değil: ${trimmed} (${err})`));
					}
					return;
				}
				this.handleLine(trimmed);
			});
		});

		child.on('exit', (code, signal) => {
			const err = new Error(`reranker süreci sonlandı (code=${code}, signal=${signal})\n${this.stderrTail.join('')}`);
			for (const entry of this.pending) {
				clearTimeout(entry.timer);
				entry.reject(err);
			}
			this.pending = [];
		});

		return ready;
	}

	private handleLine(line: string): void {
		const entry = this.pending.shift();
		if (!entry) return; // stray output (e.g. late log) — nothing waiting for it
		clearTimeout(entry.timer);
		try {
			const parsed = JSON.parse(line) as Record<string, unknown>;
			if (typeof parsed.error === 'string') {
				entry.reject(new Error(`reranker hata döndürdü: ${parsed.error}`));
				return;
			}
			entry.resolve(parsed);
		} catch (err) {
			entry.reject(new Error(`reranker: yanıt satırı JSON değil: ${line} (${err})`));
		}
	}

	private send(payload: Record<string, unknown>, kind: 'rerank' | 'stats'): Promise<unknown> {
		if (!this.child) return Promise.reject(new Error('RerankerClient henüz start() edilmedi'));
		const child = this.child;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				const idx = this.pending.findIndex((e) => e.resolve === resolve);
				if (idx !== -1) this.pending.splice(idx, 1);
				reject(new Error(`reranker: ${kind} isteği ${this.opts.requestTimeoutMs}ms içinde yanıtlanmadı`));
			}, this.opts.requestTimeoutMs);
			this.pending.push({ resolve, reject, timer, kind });
			child.stdin.write(JSON.stringify(payload) + '\n');
		});
	}

	async rerank(query: string, passages: string[]): Promise<RerankResult> {
		if (passages.length === 0) return { scores: [], ms: 0 };
		const id = String(this.nextId++);
		const result = (await this.send({ id, query, passages }, 'rerank')) as { id: string; scores: number[]; ms: number };
		return { scores: result.scores, ms: result.ms };
	}

	async stats(): Promise<RerankerStats> {
		return (await this.send({ cmd: 'stats' }, 'stats')) as RerankerStats;
	}

	/** Kills the child by its own pid, not a signal to the whole process group —
	 * this client never owns more than the one subprocess it spawned. */
	close(): void {
		if (!this.child) return;
		const pid = this.child.pid;
		if (pid !== undefined) {
			try {
				process.kill(pid);
			} catch {
				// already exited
			}
		}
		this.child = null;
		for (const entry of this.pending) {
			clearTimeout(entry.timer);
			entry.reject(new Error('reranker kapatıldı'));
		}
		this.pending = [];
	}
}
