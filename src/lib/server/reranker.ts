import { spawn, execFile } from 'node:child_process';
import type { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { logAppEvent } from './app-log';
import { dataDir } from './env';
import { defaultPythonDeps, resolvePythonBin } from './python-bin';
import { getOllamaBaseUrl, getRerankerConfig } from './providers/config-store';

/**
 * Chat-retrieval cross-encoder (BAAI/bge-reranker-v2-m3) behind a persistent
 * `python ingest/rerank_server.py` process: one JSON line in, one JSON line out (protocol in the
 * script's docstring). Same life cycle as convert-worker.ts: one process, started on first use,
 * stopped after IDLE_SHUTDOWN_MS without a request, and released (releaseReranker) before the
 * converter or formula repair claims the GPU. Chat model and reranker fit side by side on the 6 GB
 * card only in one order: chat model resident first, reranker second (rerank ~0.8 s, chat speed
 * unchanged). Started first, the reranker makes Ollama load the chat model partly onto the CPU
 * (prompt 1.4 s -> 16 s, 15 -> 9 tok/s). rerank() therefore runs a VRAM gate (decideRerankGate)
 * before every call and answers null, releasing the process where needed, when the pair would not fit.
 *
 * GPU only. On CPU 30 candidates take 9-22 s (fp32 and ONNX int8 alike), so the server is started
 * with --require-cuda and a missing CUDA means "no reranker", never a slow fallback. The chat
 * path also runs the server --offline: a missing model must fail fast, not start a 2.3 GB
 * download in the middle of a conversation (the settings page downloads it on request).
 *
 * rerank() never throws: any failure yields null (and one app-log line per distinct cause), and
 * the caller keeps today's vector-only behaviour. After a failed start the process is not
 * retried for FAILURE_BACKOFF_MS, so a machine without CUDA pays the spawn cost once, not per message.
 */

/** Idle time after which the process is stopped to free its ~1.3 GB of VRAM. */
export const IDLE_SHUTDOWN_MS = 10 * 60_000;
/** Model load on first use (~5-10 s measured) gets its own, longer limit. */
export const START_TIMEOUT_MS = 60_000;
/** One rerank request (30 candidates ~0.5-0.8 s measured). */
export const REQUEST_TIMEOUT_MS = 5_000;
/** After a failed start or timeout, how long rerank() answers null without trying again. */
export const FAILURE_BACKOFF_MS = 5 * 60_000;
const SHUTDOWN_GRACE_MS = 3_000;
const STDERR_TAIL_CHARS = 2000;

/** The slice of ChildProcess the client uses (a fake in tests). */
export interface RerankChild extends EventEmitter {
	stdin: Writable;
	stdout: Readable;
	stderr: Readable;
	kill(): unknown;
}

export interface RerankerDeps {
	/** Starts the server. May throw (no Python, missing script). */
	spawn: () => RerankChild;
	idleMs?: number;
	startTimeoutMs?: number;
	requestTimeoutMs?: number;
	failureBackoffMs?: number;
	shutdownGraceMs?: number;
	/** Called once per distinct failure cause (until a request succeeds again). */
	onFailure?: (message: string) => void;
}

export interface Reranker {
	/** Scores each passage against the query (0-1, sigmoid), or null when it cannot. */
	rerank(query: string, passages: string[]): Promise<number[] | null>;
	/** Stops the process now (frees the GPU); resolves once it has exited. */
	release(): Promise<void>;
	/** Synchronous hard kill (server process exit). */
	kill(): void;
	isRunning(): boolean;
}

interface Pending {
	resolve: (line: string) => void;
	reject: (err: Error) => void;
}

export function createReranker(deps: RerankerDeps): Reranker {
	const idleMs = deps.idleMs ?? IDLE_SHUTDOWN_MS;
	const startTimeoutMs = deps.startTimeoutMs ?? START_TIMEOUT_MS;
	const requestTimeoutMs = deps.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
	const backoffMs = deps.failureBackoffMs ?? FAILURE_BACKOFF_MS;
	const graceMs = deps.shutdownGraceMs ?? SHUTDOWN_GRACE_MS;

	let child: RerankChild | null = null;
	let ready: Promise<void> | null = null;
	let stderrTail = '';
	let pending: Pending | null = null;
	let chain: Promise<unknown> = Promise.resolve();
	let idleTimer: ReturnType<typeof setTimeout> | null = null;
	let closing: Promise<void> | null = null;
	let blockedUntil = 0;
	let lastReported: string | null = null;

	function report(message: string): void {
		if (message === lastReported) return;
		lastReported = message;
		deps.onFailure?.(message);
	}

	function clearIdle(): void {
		if (idleTimer) clearTimeout(idleTimer);
		idleTimer = null;
	}

	function armIdle(): void {
		clearIdle();
		if (!child || idleMs <= 0) return;
		idleTimer = setTimeout(() => {
			idleTimer = null;
			if (!pending) void shutdown();
		}, idleMs);
		idleTimer.unref?.();
	}

	/** Graceful stop: close stdin (the server exits at EOF), kill if it lingers. */
	function shutdown(): Promise<void> {
		clearIdle();
		const victim = child;
		if (!victim) return closing ?? Promise.resolve();
		child = null;
		ready = null;
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
			killTimer.unref?.();
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

	/** Kills the current child right away (a hung or desynchronised process). */
	function killChild(): void {
		const victim = child;
		if (!victim) return;
		clearIdle();
		child = null;
		ready = null;
		try {
			victim.kill();
		} catch {
			/* already gone */
		}
	}

	function failPending(err: Error): void {
		const p = pending;
		pending = null;
		p?.reject(err);
	}

	function start(): Promise<void> {
		const c = deps.spawn();
		child = c;
		stderrTail = '';
		c.stdin.on('error', () => {
			// EPIPE after the server died: the close handler reports it.
		});
		c.stderr.on('data', (chunk: Buffer | string) => {
			const next = stderrTail + chunk.toString();
			stderrTail = next.length > STDERR_TAIL_CHARS ? next.slice(next.length - STDERR_TAIL_CHARS) : next;
		});
		const rl = readline.createInterface({ input: c.stdout });
		return new Promise<void>((resolve, reject) => {
			let started = false;
			const timer = setTimeout(() => {
				if (started) return;
				started = true;
				killChild();
				reject(new Error(`başlatma ${startTimeoutMs} ms içinde bitmedi`));
			}, startTimeoutMs);
			rl.on('line', (line) => {
				const text = line.trim();
				if (!text) return;
				if (!started) {
					started = true;
					clearTimeout(timer);
					try {
						const msg = JSON.parse(text) as { ready?: boolean; device?: string; error?: string };
						if (msg.ready && (msg.device === undefined || msg.device === 'cuda')) return resolve();
						killChild();
						reject(new Error(msg.error ?? (msg.ready ? `cihaz ${msg.device}, cuda gerekli` : `beklenmeyen ilk satır: ${text.slice(0, 80)}`)));
					} catch {
						killChild();
						reject(new Error(`ilk satır JSON değil: ${text.slice(0, 80)}`));
					}
					return;
				}
				const p = pending;
				pending = null;
				p?.resolve(text);
			});
			const onGone = (why: string) => {
				const detail = `${why}${stderrTail.trim() ? `: ${stderrTail.trim().split('\n').slice(-2).join(' | ').slice(-300)}` : ''}`;
				// A child we already replaced or stopped on purpose must not disturb its successor.
				if (child === c) {
					child = null;
					ready = null;
					clearIdle();
					failPending(new Error(detail));
				}
				if (!started) {
					started = true;
					clearTimeout(timer);
					reject(new Error(detail));
				}
			};
			c.on('error', (err: Error) => onGone(`süreç hatası ${err.message}`));
			c.on('close', (code: number | null, signal: NodeJS.Signals | null) => onGone(`süreç kapandı (code=${code}, signal=${signal})`));
		});
	}

	function request(payload: unknown): Promise<string> {
		return new Promise<string>((resolve, reject) => {
			const c = child;
			if (!c) return reject(new Error('süreç yok'));
			const timer = setTimeout(() => {
				// A late answer would be read as the next request's; the only safe move is a restart.
				failPending(new Error(`yanıt ${requestTimeoutMs} ms içinde gelmedi`));
				killChild();
			}, requestTimeoutMs);
			pending = {
				resolve: (line) => {
					clearTimeout(timer);
					resolve(line);
				},
				reject: (err) => {
					clearTimeout(timer);
					reject(err);
				}
			};
			try {
				c.stdin.write(JSON.stringify(payload) + '\n');
			} catch (err) {
				failPending(err instanceof Error ? err : new Error(String(err)));
			}
		});
	}

	async function run(query: string, passages: string[]): Promise<number[] | null> {
		if (Date.now() < blockedUntil) return null;
		if (closing) await closing;
		try {
			if (!child) {
				ready = start();
			}
			await ready;
			clearIdle();
			const line = await request({ id: 'r', query, passages });
			const msg = JSON.parse(line) as { scores?: unknown; error?: string };
			if (typeof msg.error === 'string') throw new Error(`sunucu hatası: ${msg.error}`);
			if (!Array.isArray(msg.scores) || msg.scores.length !== passages.length || !msg.scores.every((n) => typeof n === 'number')) {
				throw new Error('geçersiz skor listesi');
			}
			lastReported = null;
			armIdle();
			return msg.scores as number[];
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			// A broken start/timeout would repeat on the next message: do not retry for a while.
			blockedUntil = Date.now() + backoffMs;
			killChild();
			report(message);
			return null;
		}
	}

	return {
		rerank(query, passages) {
			if (passages.length === 0) return Promise.resolve([]);
			// One request at a time: the protocol is strictly FIFO over a single pipe.
			const next = chain.then(() => run(query, passages));
			chain = next.catch(() => undefined);
			return next;
		},
		release: () => shutdown(),
		kill() {
			clearIdle();
			try {
				child?.kill();
			} catch {
				/* already gone */
			}
		},
		isRunning: () => child !== null || closing !== null
	};
}

// ---------------------------------------------------------------------------
// App wiring: process-wide instance, paths, status, model download.
// ---------------------------------------------------------------------------

export const RERANKER_MODEL = 'BAAI/bge-reranker-v2-m3';
export const RERANKER_REVISION = '953dc6f6f85a1b2dbfca4c34a2796e7dde08d41e';
const SERVER_SCRIPT = 'rerank_server.py';

function safeDataDir(): string | null {
	try {
		return dataDir();
	} catch {
		return null;
	}
}

/** Hugging Face cache root for the reranker: HF_HOME when set (tests, the benchmark), else <dataDir>/models/hf. */
export function rerankerHfHome(): string {
	const fromEnv = process.env.HF_HOME?.trim();
	return fromEnv ? path.resolve(fromEnv) : path.join(dataDir(), 'models', 'hf');
}

/** True when the pinned model's weights are in the cache (a filesystem check, no Python). */
export function rerankerModelPresent(hfHome: string = rerankerHfHome()): boolean {
	const snapshot = path.join(hfHome, 'hub', `models--${RERANKER_MODEL.replace('/', '--')}`, 'snapshots', RERANKER_REVISION);
	return fs.existsSync(path.join(snapshot, 'model.safetensors')) && fs.existsSync(path.join(snapshot, 'config.json'));
}

function serverScriptPath(): string {
	return path.resolve(process.cwd(), 'ingest', SERVER_SCRIPT);
}

function pythonPath(): string {
	return resolvePythonBin(defaultPythonDeps(safeDataDir()));
}

function serverEnv(): NodeJS.ProcessEnv {
	return { ...process.env, HF_HOME: rerankerHfHome(), PYTHONIOENCODING: 'utf-8' };
}

let shared: Reranker | null = null;
function getReranker(): Reranker {
	if (!shared) {
		shared = createReranker({
			spawn: () =>
				spawn(pythonPath(), [serverScriptPath(), '--offline', '--require-cuda', '--device', 'cuda', '--dtype', 'fp16'], {
					windowsHide: true,
					env: serverEnv()
				}) as unknown as RerankChild,
			onFailure: (message) => logAppEvent({ kind: 'reranker_issue', message: `reranker kullanılamadı, vektör sırası kullanılıyor: ${message}` })
		});
		process.once('exit', () => shared?.kill());
	}
	return shared;
}


// ---------------------------------------------------------------------------
// VRAM gate: the reranker may only run when it cannot hurt the chat model.
// ---------------------------------------------------------------------------

/** Free VRAM the reranker process needs to start: 1217 MiB measured (fp16, CUDA context included) plus ~80 MiB margin. */
export const RERANKER_VRAM_MB = 1300;
/** Free VRAM needed to start beside a fully resident Ollama chat model (see decideRerankGate). */
export const RERANKER_VRAM_MB_BESIDE_RESIDENT = 900;
const PS_TIMEOUT_MS = 1_000;
const NVIDIA_SMI_TIMEOUT_MS = 2_000;

export type RerankSkipReason = 'chat-model-not-loaded' | 'chat-model-offloaded' | 'insufficient-vram';

export interface PsModel {
	name: string;
	size: number;
	size_vram: number;
}

export interface GateInputs {
	/** Normalized Ollama chat model; undefined for a cloud chat provider. */
	localModel?: string;
	/** /api/ps models, or null when Ollama did not answer. Only read when localModel is set. */
	ps: PsModel[] | null;
	/** The reranker process is alive (its own memory then already shows as used). */
	running: boolean;
	/** nvidia-smi memory.free in MiB, or null when unknown. Only read when the process is not running. */
	freeVramMb: number | null;
}

export type GateDecision = { action: 'run' } | { action: 'skip-release'; reason: RerankSkipReason } | { action: 'skip'; reason: RerankSkipReason };

/** `bge-m3:latest` and `bge-m3` are one model. */
export function normalizeOllamaName(model: string): string {
	return model.endsWith(':latest') ? model.slice(0, -':latest'.length) : model;
}

/**
 * Pure decision. 'skip-release': this turn goes without the reranker AND the process must exit (the chat
 * model is about to load, or is already squeezed). 'skip': just this turn.
 */
export function decideRerankGate(i: GateInputs): GateDecision {
	if (i.localModel !== undefined) {
		const wanted = normalizeOllamaName(i.localModel);
		const entry = i.ps?.find((m) => normalizeOllamaName(m.name) === wanted);
		if (!entry) return { action: 'skip-release', reason: 'chat-model-not-loaded' };
		if (entry.size_vram < entry.size) return { action: 'skip-release', reason: 'chat-model-offloaded' };
	}
	// With the local chat model already fully resident, part of the reranker may spill to shared memory
	// without touching it (measured: qwen3:8b-bart-iq4xs at num_ctx 8192, 1075 MiB free, rerank 0.5 -> 0.8 s,
	// chat 35 tok/s unchanged over 4 rounds). Only a model loading AFTER the reranker gets pushed off the GPU,
	// and the checks above already prevent that. A cloud chat has nothing to protect but needs real headroom.
	const needMb = i.localModel !== undefined ? RERANKER_VRAM_MB_BESIDE_RESIDENT : RERANKER_VRAM_MB;
	if (!i.running && i.freeVramMb !== null && i.freeVramMb < needMb) {
		return { action: 'skip', reason: 'insufficient-vram' };
	}
	return { action: 'run' };
}

async function readOllamaPs(): Promise<PsModel[] | null> {
	try {
		const res = await fetch(`${getOllamaBaseUrl()}/api/ps`, { signal: AbortSignal.timeout(PS_TIMEOUT_MS) });
		if (!res.ok) return null;
		const data = (await res.json()) as { models?: { name?: string; model?: string; size?: number; size_vram?: number }[] };
		return (data.models ?? []).map((m) => ({ name: m.name ?? m.model ?? '', size: m.size ?? 0, size_vram: m.size_vram ?? 0 }));
	} catch {
		return null;
	}
}

function readFreeVramMb(): Promise<number | null> {
	return new Promise((resolve) => {
		try {
			execFile(
				'nvidia-smi',
				['--query-gpu=memory.free', '--format=csv,noheader,nounits'],
				{ windowsHide: true, timeout: NVIDIA_SMI_TIMEOUT_MS, encoding: 'utf8' },
				(err, stdout) => {
					if (err) return resolve(null);
					// One line per GPU; the reranker runs on device 0.
					const n = Number.parseInt(String(stdout).split('\n')[0].trim(), 10);
					resolve(Number.isFinite(n) ? n : null);
				}
			);
		} catch {
			resolve(null);
		}
	});
}

let lastSkip: RerankSkipReason | undefined;
let lastLoggedSkip: RerankSkipReason | undefined;

function recordGate(decision: GateDecision): void {
	if (decision.action === 'run') {
		lastSkip = undefined;
		lastLoggedSkip = undefined;
		return;
	}
	lastSkip = decision.reason;
	// 'not loaded' is the normal cold start (the model loads this turn); only the real problems are logged, once.
	if (decision.reason !== 'chat-model-not-loaded' && lastLoggedSkip !== decision.reason) {
		lastLoggedSkip = decision.reason;
		logAppEvent({
			kind: 'reranker_issue',
			message: `reranker bu tur atlandı (${decision.reason}): sohbet modeliyle birlikte GPU'ya sığmıyor, vektör sırası kullanılıyor`
		});
	}
}

let missingModelReported = false;

/**
 * Scores passages against the query, or null when the reranker cannot (no model, no CUDA, no
 * Python, timeout, error). Callers must treat null as "behave as without a reranker".
 */
export async function rerank(query: string, passages: string[], opts: { localModel?: string } = {}): Promise<number[] | null> {
	if (passages.length === 0) return [];
	if (!rerankerModelPresent()) {
		if (!missingModelReported) {
			missingModelReported = true;
			logAppEvent({ kind: 'reranker_issue', message: 'reranker açık ama model indirilmemiş, vektör sırası kullanılıyor' });
		}
		return null;
	}
	const running = rerankerIsRunning();
	const decision = decideRerankGate({
		localModel: opts.localModel,
		ps: opts.localModel !== undefined ? await readOllamaPs() : null,
		running,
		freeVramMb: running ? null : await readFreeVramMb()
	});
	recordGate(decision);
	if (decision.action === 'skip-release') await releaseReranker();
	if (decision.action !== 'run') return null;
	return getReranker().rerank(query, passages);
}

/** Stops the reranker process if one exists. Call before a heavy GPU job (converter worker, formula repair). */
export async function releaseReranker(): Promise<void> {
	await shared?.release();
}

/** True while a reranker process is alive; lets callers skip an await when there is nothing to release. */
export function rerankerIsRunning(): boolean {
	return shared?.isRunning() ?? false;
}

export interface RerankerStatus {
	/** The user's setting (providers.json). */
	enabled: boolean;
	/** The resolved Python imports torch and transformers. */
	pythonOk: boolean;
	/** torch sees a CUDA device (the reranker is GPU-only). */
	cuda: boolean;
	/** The model weights are in the cache. */
	modelPresent: boolean;
	/** The server process is alive right now. */
	running: boolean;
	/** A model download is in progress. */
	downloading: boolean;
	/** Why the last chat turn went without the reranker (VRAM gate); undefined when it ran. */
	lastSkip?: RerankSkipReason;
}

interface ProbeResult {
	ok: boolean;
	cuda: boolean;
}

const PROBE_TIMEOUT_MS = 90_000;
const FAILED_PROBE_TTL_MS = 30_000;
let probeCache: { python: string; at: number; result: ProbeResult } | null = null;
let probeInFlight: Promise<ProbeResult> | null = null;

function parseProbe(stdout: string): ProbeResult {
	for (const line of stdout.split('\n').reverse()) {
		try {
			const msg = JSON.parse(line.trim()) as { ok?: boolean; cuda?: boolean };
			if (typeof msg.ok === 'boolean') return { ok: msg.ok, cuda: msg.ok && msg.cuda === true };
		} catch {
			/* not the JSON line */
		}
	}
	return { ok: false, cuda: false };
}

/** `rerank_server.py --probe` once per interpreter: importing torch costs seconds, so the answer is cached. */
function probeEnvironment(): Promise<ProbeResult> {
	let python: string;
	try {
		python = pythonPath();
	} catch {
		return Promise.resolve({ ok: false, cuda: false });
	}
	if (probeCache && probeCache.python === python && (probeCache.result.ok || Date.now() - probeCache.at < FAILED_PROBE_TTL_MS)) {
		return Promise.resolve(probeCache.result);
	}
	if (probeInFlight) return probeInFlight;
	probeInFlight = new Promise<ProbeResult>((resolve) => {
		execFile(
			python,
			[serverScriptPath(), '--probe'],
			{ windowsHide: true, timeout: PROBE_TIMEOUT_MS, env: serverEnv(), encoding: 'utf8' },
			(err, stdout) => resolve(err ? { ok: false, cuda: false } : parseProbe(String(stdout)))
		);
	}).then((result) => {
		probeCache = { python, at: Date.now(), result };
		probeInFlight = null;
		return result;
	});
	return probeInFlight;
}

let downloadInFlight: Promise<void> | null = null;

export function rerankerDownloading(): boolean {
	return downloadInFlight !== null;
}

export async function rerankerStatus(): Promise<RerankerStatus> {
	const running = rerankerIsRunning();
	// A live server already proved Python and CUDA; skip the multi-second probe.
	const probe = running ? { ok: true, cuda: true } : await probeEnvironment();
	return {
		enabled: getRerankerConfig().enabled,
		pythonOk: probe.ok,
		cuda: probe.cuda,
		modelPresent: rerankerModelPresent(),
		running,
		downloading: rerankerDownloading(),
		...(lastSkip ? { lastSkip } : {})
	};
}

const DOWNLOAD_TIMEOUT_MS = 60 * 60_000;

/**
 * Fetches the pinned model into the cache (`--download-only`, the one place the reranker is
 * allowed on the network). Concurrent calls share one download. Rejects with the Python error.
 */
export function downloadRerankerModel(): Promise<void> {
	if (downloadInFlight) return downloadInFlight;
	downloadInFlight = new Promise<void>((resolve, reject) => {
		let python: string;
		try {
			python = pythonPath();
		} catch (err) {
			return reject(err instanceof Error ? err : new Error(String(err)));
		}
		execFile(
			python,
			[serverScriptPath(), '--download-only'],
			{ windowsHide: true, timeout: DOWNLOAD_TIMEOUT_MS, env: serverEnv(), encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
			(err, stdout, stderr) => {
				if (err) return reject(new Error(String(stderr).trim().split('\n').slice(-3).join(' | ') || err.message));
				const ok = String(stdout)
					.split('\n')
					.some((l) => {
						try {
							return (JSON.parse(l.trim()) as { downloaded?: boolean }).downloaded === true;
						} catch {
							return false;
						}
					});
				if (!ok) return reject(new Error('indirme tamamlandı bildirmedi'));
				resolve();
			}
		);
	}).finally(() => {
		downloadInFlight = null;
	});
	return downloadInFlight;
}
