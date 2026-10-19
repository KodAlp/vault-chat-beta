import { spawn } from 'node:child_process';
import type { EventEmitter } from 'node:events';
import readline from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { AppError } from './app-error';
import { forwardedConvertCode, type ForwardedConvertCode } from './convert-error-codes';
import { isNativeCrash, type AttemptOutcome } from './convert-crash';
import { PROCESS_TIMEOUT_MS, pdfEstimatedSeconds, pdfTimeoutMs } from './convert-timeouts';
import type { ConvertEvent } from './convertQueue';
import { releaseReranker, rerankerIsRunning } from './reranker';

/**
 * A persistent `python ingest/convert.py --serve` process that converts one
 * file after another, so docling's models are loaded once instead of once per
 * file (the formula recognizer alone costs 20-45 s on the RTX 4050; a 700-PDF
 * batch wasted hours). Protocol (see convert.py's serve()): one JSON request
 * per stdin line, `{"id", "args": [...CLI args]}`; every event line on stdout
 * carries that `id`; `{"type":"end","id","exit"}` closes the request.
 *
 * Exactly ONE worker and ONE request at a time: a 6 GB card cannot hold two
 * copies of the models. convertQueue.ts's batch "concurrency" therefore only
 * overlaps the other steps; a second conversion waits here in a FIFO (while
 * holding its sharedJobMutex slot, which is harmless).
 *
 * The worker is stopped after IDLE_SHUTDOWN_MS without a request (its models
 * sit in GPU memory the chat model needs), by releaseConverterWorker() when a
 * chat model is about to load, and recycled every RECYCLE_AFTER_CONVERSIONS
 * as a memory-growth safety net. A hung or timed-out request kills the worker
 * (the only way to stop docling); the next request starts a fresh one.
 */

/** Idle time after which the worker is shut down to free the GPU. */
export const IDLE_SHUTDOWN_MS = 2 * 60_000;
/** The worker is restarted after this many conversions (memory growth safety). */
export const RECYCLE_AFTER_CONVERSIONS = 50;
/** After closing stdin, how long a worker may take to exit before it is killed. */
const SHUTDOWN_GRACE_MS = 5_000;
/** Rolling stderr kept per worker for crash/diagnostic detail. */
const STDERR_TAIL_BYTES = 4096;

export type DoneEvent = ConvertEvent & { type: 'done' };
export type WorkerOutcome = AttemptOutcome<DoneEvent>;

/** Wire event: a ConvertEvent plus the request id, or the closing `end`. */
export type WorkerLine = (ConvertEvent | { type: 'end'; exit?: number }) & { id: string };

/**
 * Parses one stdout line and returns it only when it is a JSON object with a
 * string `id` and a `type`. Non-JSON noise (a library printing to stdout) and
 * lines without an id yield null.
 */
export function parseWorkerLine(line: string): WorkerLine | null {
	if (!line.trim()) return null;
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		return null;
	}
	if (typeof value !== 'object' || value === null) return null;
	const rec = value as Record<string, unknown>;
	if (typeof rec.id !== 'string' || typeof rec.type !== 'string') return null;
	return rec as unknown as WorkerLine;
}

/** What one in-flight request has seen so far; input to the classifiers. */
export interface JobProgress {
	done: DoneEvent | null;
	error: string | null;
	errorCode: ForwardedConvertCode | null;
	timedOut: boolean;
	timeoutMs: number;
}

export function newJobProgress(): JobProgress {
	return { done: null, error: null, errorCode: null, timedOut: false, timeoutMs: PROCESS_TIMEOUT_MS };
}

/**
 * Applies one (id-stripped) event to the request's progress. Returns the new
 * timeout in ms when the event is the early PDF `pageCount` progress event —
 * which also gets `estimatedSeconds` added — otherwise null. A page count of
 * 0 means pdf_page_count() itself failed (malformed PDF), which is exactly
 * when the startup-hang floor should stay in effect.
 */
export function applyEvent(progress: JobProgress, event: ConvertEvent): number | null {
	let newTimeout: number | null = null;
	if (event.type === 'progress' && event.pageCount) {
		newTimeout = pdfTimeoutMs(event.pageCount);
		progress.timeoutMs = newTimeout;
		event.estimatedSeconds = pdfEstimatedSeconds(event.pageCount);
	}
	if (event.type === 'done') progress.done = event;
	if (event.type === 'error') {
		progress.error = event.message;
		progress.errorCode = forwardedConvertCode(event.code);
	}
	return newTimeout;
}

function doneOrError(p: JobProgress): WorkerOutcome | null {
	if (p.done) return { kind: 'done', value: p.done };
	if (p.error) {
		// Only allow-listed codes pass through; anything else Python sends
		// stays a generic CONVERSION_FAILED.
		return {
			kind: 'error',
			error: new AppError(p.errorCode ?? 'CONVERSION_FAILED', p.errorCode ? undefined : { detail: p.error })
		};
	}
	return null;
}

/** The request finished (`end` event) while the worker stays alive. */
export function classifyEnd(p: JobProgress, exit: number | undefined): WorkerOutcome {
	return (
		doneOrError(p) ?? {
			kind: 'error',
			error: new AppError('CONVERSION_FAILED', { detail: `exit ${exit ?? '?'}: bilinmeyen hata` })
		}
	);
}

/** The worker process died while the request was in flight. Same order as the
 * per-process path always had: timeout, done, error, native crash, other. */
export function classifyExit(
	p: JobProgress,
	code: number | null,
	signal: NodeJS.Signals | null,
	stderrTail: string
): WorkerOutcome {
	if (p.timedOut) {
		// Checked first — the request may have finished writing `done` just as
		// the timer fired, which must not report success for a killed run.
		return { kind: 'error', error: new AppError('PROCESS_TIMEOUT', { seconds: Math.round(p.timeoutMs / 1000) }) };
	}
	// Also covers a crash AFTER `done` — the result was already delivered.
	const settled = doneOrError(p);
	if (settled) return settled;
	if (isNativeCrash(code, signal)) {
		return { kind: 'crash', detail: `exit ${code ?? signal}: ${stderrTail.slice(-300) || 'no stderr'}` };
	}
	return {
		kind: 'error',
		error: new AppError('CONVERSION_FAILED', { detail: `exit ${code ?? signal}: ${stderrTail.slice(-500) || 'bilinmeyen hata'}` })
	};
}

/** Keeps only the last `max` characters of a rolling buffer. */
export function appendTail(tail: string, chunk: string, max = STDERR_TAIL_BYTES): string {
	const next = tail + chunk;
	return next.length > max ? next.slice(next.length - max) : next;
}

/** The slice of ChildProcess the worker uses (a fake in tests). */
export interface WorkerChild extends EventEmitter {
	stdin: Writable;
	stdout: Readable;
	stderr: Readable;
	kill(): unknown;
}

export interface ConvertWorkerDeps {
	/** Starts `convert.py --serve`. May throw (e.g. no Python found). */
	spawn: () => WorkerChild;
	idleMs?: number;
	recycleAfter?: number;
	shutdownGraceMs?: number;
	/** Test hook: log lines the worker ignores. */
	onIgnoredLine?: (line: string) => void;
}

export interface ConvertWorker {
	/** Queues one conversion; resolves with the classified outcome. */
	run(args: string[], onEvent?: (event: ConvertEvent) => void): Promise<WorkerOutcome>;
	/** Shuts the worker down now if it is idle; a no-op while busy. */
	release(): Promise<void>;
	/** Synchronous hard kill (server process exit): never leave docling running. */
	kill(): void;
	/** True while a request is running or queued. */
	isBusy(): boolean;
	/** True while a worker process is alive (or shutting down). */
	isRunning(): boolean;
}

interface Job {
	id: string;
	args: string[];
	onEvent?: (event: ConvertEvent) => void;
	resolve: (outcome: WorkerOutcome) => void;
	progress: JobProgress;
	timer: ReturnType<typeof setTimeout> | null;
	settled: boolean;
}

export function createConvertWorker(deps: ConvertWorkerDeps): ConvertWorker {
	const idleMs = deps.idleMs ?? IDLE_SHUTDOWN_MS;
	const recycleAfter = deps.recycleAfter ?? RECYCLE_AFTER_CONVERSIONS;
	const graceMs = deps.shutdownGraceMs ?? SHUTDOWN_GRACE_MS;

	let child: WorkerChild | null = null;
	let served = 0; // conversions answered by the current child
	let stderrTail = '';
	let seq = 0;
	let current: Job | null = null;
	const queue: Job[] = [];
	let idleTimer: ReturnType<typeof setTimeout> | null = null;
	// Resolves when the previous child has fully exited; a new one is only
	// started after it, so two copies of the models never share the GPU.
	let closing: Promise<void> | null = null;
	let pumping = false;

	function clearIdle(): void {
		if (idleTimer) clearTimeout(idleTimer);
		idleTimer = null;
	}

	function armIdle(): void {
		clearIdle();
		if (!child || idleMs <= 0) return;
		idleTimer = setTimeout(() => {
			idleTimer = null;
			if (!current && queue.length === 0) void shutdown();
		}, idleMs);
		idleTimer.unref?.();
	}

	/** Graceful stop: close stdin (convert.py exits 0 on EOF), kill if it lingers. */
	function shutdown(): Promise<void> {
		clearIdle();
		const victim = child;
		if (!victim) return closing ?? Promise.resolve();
		child = null;
		const p = new Promise<void>((resolve) => {
			let finished = false;
			const finish = () => {
				if (finished) return;
				finished = true;
				clearTimeout(killTimer);
				resolve();
			};
			const killTimer = setTimeout(() => {
				try {
					victim.kill();
				} catch {
					/* already gone */
				}
			}, graceMs);
			victim.once('close', finish);
			victim.once('error', finish);
			try {
				victim.stdin.end();
			} catch {
				try {
					victim.kill();
				} catch {
					/* already gone */
				}
			}
		}).then(() => {
			if (closing === p) closing = null;
		});
		closing = p;
		return p;
	}

	function settle(job: Job, outcome: WorkerOutcome): void {
		if (job.settled) return;
		job.settled = true;
		if (job.timer) clearTimeout(job.timer);
		job.timer = null;
		if (current === job) current = null;
		job.resolve(outcome);
	}

	function startTimer(job: Job, ms: number): void {
		if (job.timer) clearTimeout(job.timer);
		job.timer = setTimeout(() => {
			job.progress.timedOut = true;
			// Killing the worker is the only way to stop docling; the request
			// is resolved from the child's close event so the GPU is free by
			// the time the next request starts.
			try {
				child?.kill();
			} catch {
				/* already gone */
			}
		}, ms);
	}

	function afterJob(): void {
		if (child && served >= recycleAfter) void shutdown();
		else if (queue.length === 0) armIdle();
		void pump();
	}

	function startChild(): WorkerChild {
		const c = deps.spawn();
		child = c;
		served = 0;
		stderrTail = '';
		c.stdin.on('error', () => {
			// EPIPE after the worker died: the close handler classifies it.
		});
		const rl = readline.createInterface({ input: c.stdout });
		rl.on('line', (line) => onLine(c, line));
		c.stderr.on('data', (chunk: Buffer | string) => {
			stderrTail = appendTail(stderrTail, chunk.toString());
		});
		c.on('error', (err: Error) => {
			if (child === c) child = null;
			const job = current;
			if (job) settle(job, { kind: 'error', error: new AppError('PYTHON_SPAWN_FAILED', { detail: err.message }) });
			afterJob();
		});
		c.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
			if (child === c) child = null;
			clearIdle();
			const job = current;
			if (job) settle(job, classifyExit(job.progress, code, signal, stderrTail));
			afterJob();
		});
		return c;
	}

	function onLine(from: WorkerChild, line: string): void {
		const msg = parseWorkerLine(line);
		const job = current;
		if (!msg || from !== child || !job || msg.id !== job.id) {
			// Noise, or a stale line of a request that no longer exists.
			if (line.trim()) deps.onIgnoredLine?.(line);
			return;
		}
		if (msg.type === 'end') {
			// A timed-out request is resolved by the kill's close event instead.
			if (job.progress.timedOut) return;
			served++;
			settle(job, classifyEnd(job.progress, (msg as { exit?: number }).exit));
			afterJob();
			return;
		}
		const { id: _id, ...rest } = msg;
		const event = rest as ConvertEvent;
		const newTimeout = applyEvent(job.progress, event);
		if (newTimeout !== null) startTimer(job, newTimeout);
		job.onEvent?.(event);
	}

	async function pump(): Promise<void> {
		if (pumping) return;
		pumping = true;
		try {
			while (!current && queue.length > 0) {
				if (closing) {
					await closing;
					continue;
				}
				const job = queue.shift()!;
				current = job;
				clearIdle();
				let c = child;
				if (!c) {
					// The chat reranker holds ~1.3 GB of VRAM; docling's models need it. The sync check keeps
					// the common case (no reranker running) free of an extra await.
					if (rerankerIsRunning()) await releaseReranker();
					try {
						c = startChild();
					} catch (err) {
						settle(job, {
							kind: 'error',
							error: new AppError('PYTHON_SPAWN_FAILED', { detail: err instanceof Error ? err.message : String(err) })
						});
						continue;
					}
				}
				stderrTail = '';
				startTimer(job, job.progress.timeoutMs);
				try {
					c.stdin.write(JSON.stringify({ id: job.id, args: job.args }) + '\n');
				} catch {
					// The close handler reports the dead worker.
				}
			}
		} finally {
			pumping = false;
		}
	}

	return {
		run(args, onEvent) {
			return new Promise<WorkerOutcome>((resolve) => {
				queue.push({
					id: String(++seq),
					args,
					onEvent,
					resolve,
					progress: newJobProgress(),
					timer: null,
					settled: false
				});
				void pump();
			});
		},
		async release() {
			if (current || queue.length > 0) return;
			await shutdown();
		},
		kill() {
			clearIdle();
			try {
				child?.kill();
			} catch {
				/* already gone */
			}
		},
		isBusy: () => current !== null || queue.length > 0,
		isRunning: () => child !== null || closing !== null
	};
}

/**
 * Environment of the Python converter process (per-file and --serve alike). PANDOC_BIN only when
 * resolved (an unset one must not shadow convert.py's own PATH lookup). VC_NODE_BIN is the Node
 * binary running this server: ingest/formula_fallback.py runs ingest/katex_check.mjs with it to
 * validate formulas against the real KaTeX, and a packaged app has no `node` on PATH.
 */
export function convertProcessEnv(
	pandocBin: string | null,
	nodeBin: string = process.execPath,
	base: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...base, VC_NODE_BIN: nodeBin };
	if (pandocBin) env.PANDOC_BIN = pandocBin;
	return env;
}

/** Real worker: `python <script> --serve`. Same PANDOC_BIN logic as the per-file path. */
export function spawnConvertWorker(pythonBin: string, script: string, pandocBin: string | null): WorkerChild {
	return spawn(pythonBin, [script, '--serve'], {
		windowsHide: true,
		env: convertProcessEnv(pandocBin)
	}) as unknown as WorkerChild;
}

// The process-wide worker is created by convertQueue.ts (it owns the Python
// path resolution) and registered here, so that light modules such as the
// Ollama gate can release it without importing convertQueue's dependencies.
let sharedWorker: ConvertWorker | null = null;

export function setSharedConvertWorker(worker: ConvertWorker | null): void {
	sharedWorker = worker;
}

/**
 * Shuts the converter worker down right now if it is idle (frees the GPU
 * memory its docling models hold); a no-op while a conversion is running or
 * queued, and when no worker exists. Resolves once the process has exited.
 */
export async function releaseConverterWorker(): Promise<void> {
	await sharedWorker?.release();
}
