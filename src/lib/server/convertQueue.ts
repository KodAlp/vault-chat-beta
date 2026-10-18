import { spawn } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import { sharedJobMutex } from './jobMutex';
import { AppError } from './app-error';
import { resolvePandocBin } from './pandoc-bin';
import { resolvePythonBin, defaultPythonDeps } from './python-bin';
import { dataDir } from './env';
import { evictForExclusiveJob } from './gpu-evict';
import { assertFileClean } from './av-guard';
import { forwardedConvertCode } from './convert-error-codes';
import { isNativeCrash, runWithCrashRetry, type AttemptOutcome } from './convert-crash';
import { PROCESS_TIMEOUT_MS, pdfEstimatedSeconds, pdfTimeoutMs } from './convert-timeouts';
import {
	convertProcessEnv,
	createConvertWorker,
	setSharedConvertWorker,
	spawnConvertWorker,
	type ConvertWorker
} from './convert-worker';

function safeDataDir(): string | null {
	try {
		return dataDir();
	} catch {
		return null;
	}
}

export type ConvertEvent =
	| { type: 'progress'; stage: string; pageCount?: number; estimatedSeconds?: number }
	| {
		type: 'done';
		outPath: string | null;
		frontmatter: Record<string, unknown>;
		warnings: string[];
		/** File names under `<outPath dir>/images/` (convert.py --images, default on); see converted-images.ts. */
		images?: string[];
		imageStats?: Record<string, number> | null;
	}
	| { type: 'error'; message: string; code?: string };

/**
 * A bare 'python' resolved via PATH lookup inside spawn() can land on the
 * Microsoft Store "App Execution Alias" redirector
 * (%LOCALAPPDATA%\Microsoft\WindowsApps\python.exe) instead of a real
 * interpreter, if the server process's PATH order differs from an
 * interactive shell's (e.g. a long-running `npm run dev` started from a
 * different profile). That redirector is a packaged-app activation shim
 * and reliably crashes with STATUS_DLL_INIT_FAILED (exit 0xC0000142 /
 * 3221225794) when spawned with piped, non-console stdio — exactly what
 * child_process.spawn does. Fix: never trust a bare PATH lookup here;
 * resolve to a real, absolute interpreter path once, then cache it.
 */

// Lazy + memoized, not resolved at module load — env.ts's own "every
// accessor is a function" rule (see its doc comment): a caller that sets
// process.env.PYTHON_BIN before importing this module (a test, a bootstrap
// script) must not lose to a value this module already captured at import
// time.
let cachedPythonBin: string | null = null;
/** Dropped after the app venv is created so the next pythonBin() picks it up. */
export function resetPythonBinCache(): void {
	cachedPythonBin = null;
}
/** Exported so youtubeQueue.ts's yt-dlp sidecar reuses the exact same
 * Windows path-resolution fixes instead of a second, driftable copy —
 * see resolvePythonBin()'s doc comment for the bugs this avoids. */
export function pythonBin(): string {
	if (cachedPythonBin === null) cachedPythonBin = resolvePythonBin(defaultPythonDeps(safeDataDir()));
	return cachedPythonBin;
}

const CONVERT_PY = path.resolve(process.cwd(), 'ingest', 'convert.py');

/** Absolute path of another script in the same ingest/ folder (same resolution as convert.py). */
export function ingestScriptPath(name: string): string {
	return path.resolve(path.dirname(CONVERT_PY), name);
}

/**
 * Conversions run on ONE persistent `convert.py --serve` worker
 * (convert-worker.ts) so docling's models are loaded once, not per file.
 * `VC_CONVERT_WORKER=0` is the escape hatch: spawn a fresh convert.py process
 * per file again (runConvertAttemptSpawn below), the pre-2026-10-08 behavior.
 * Read lazily, like env.ts's accessors, so a test or bootstrap can set it late.
 */
function convertWorkerEnabled(): boolean {
	return process.env.VC_CONVERT_WORKER?.trim() !== '0';
}

let convertWorker: ConvertWorker | null = null;
function getConvertWorker(): ConvertWorker {
	if (!convertWorker) {
		convertWorker = createConvertWorker({
			spawn: () => spawnConvertWorker(pythonBin(), CONVERT_PY, resolvePandocBin())
		});
		setSharedConvertWorker(convertWorker);
		// A conversion left running when the server dies would hold the GPU.
		process.once('exit', () => convertWorker?.kill());
	}
	return convertWorker;
}

/**
 * Runs one conversion (never in parallel — see queue below). Rejects with a
 * readable message on failure; never leaves the caller staring at a hung
 * process or a raw stack trace.
 *
 * A native crash of the converter process (docling-parse #357, see
 * convert-crash.ts) gets exactly one automatic retry inside the same queue
 * slot, run with `--pdf-backend hybrid` (the fallback PDF reader); a second
 * crash surfaces as CONVERTER_CRASHED.
 */
function runConvert(
	inPath: string,
	outDir: string,
	tool: string,
	onEvent?: (event: ConvertEvent) => void,
	sourceName?: string,
	pages?: string,
	ocrLang?: string
): Promise<ConvertEvent & { type: 'done' }> {
	return runWithCrashRetry(
		(attemptNumber) =>
			runConvertAttempt(
				inPath,
				outDir,
				tool,
				onEvent,
				sourceName,
				pages,
				attemptNumber === 1 ? 'hybrid' : undefined,
				ocrLang
			),
		(crashDetail) => {
			// Keep the diagnosis: the user only ever sees the retry notice.
			console.warn(`[convert] converter crashed, retrying once with the fallback PDF backend: ${crashDetail}`);
			onEvent?.({ type: 'progress', stage: 'retrying' });
		}
	);
}

/** CLI arguments of one convert.py run (without the script path). */
export function buildConvertArgs(
	inPath: string,
	outDir: string,
	tool: string,
	sourceName?: string,
	pages?: string,
	pdfBackend?: 'hybrid',
	ocrLang?: string
): string[] {
	const args = ['--in', inPath, '--out-dir', outDir, '--tool', tool];
	// The real filename (E5/K2-5) — every caller stages the input under a
	// generic name ("original.pdf") to keep the staging dir collision-free,
	// which is why convert.py can no longer be trusted to know its own
	// source_file/title fallback from --in alone. See convert.py's module
	// docstring for the "original"/"input" title bug this fixes.
	if (sourceName) args.push('--source-name', sourceName);
	// #37 — see convert.py's parse_page_range for the "START-END" format.
	if (pages) args.push('--pages', pages);
	// Fallback PDF reader, only for the retry after a native crash — see
	// convert.py's module docstring (--pdf-backend).
	if (pdfBackend) args.push('--pdf-backend', pdfBackend);
	// OCR language(s) for scanned pages: the vault's language or a per-import
	// choice (ocr-lang.ts); convert.py maps names/codes and warns when unsupported.
	if (ocrLang) args.push('--ocr-lang', ocrLang);
	return args;
}

/**
 * One conversion attempt, classified into done / error / native crash.
 * Goes through the persistent worker unless VC_CONVERT_WORKER=0. The worker
 * runs requests one at a time, so with batch concurrency > 1 the second
 * conversion just waits in the worker's FIFO, still holding its
 * sharedJobMutex shared slot; that only delays an exclusive job (a chat
 * model swap) that would have had to wait for it anyway.
 */
function runConvertAttempt(
	inPath: string,
	outDir: string,
	tool: string,
	onEvent?: (event: ConvertEvent) => void,
	sourceName?: string,
	pages?: string,
	pdfBackend?: 'hybrid',
	ocrLang?: string
): Promise<AttemptOutcome<ConvertEvent & { type: 'done' }>> {
	if (!convertWorkerEnabled()) {
		return runConvertAttemptSpawn(inPath, outDir, tool, onEvent, sourceName, pages, pdfBackend, ocrLang);
	}
	return getConvertWorker().run(
		buildConvertArgs(inPath, outDir, tool, sourceName, pages, pdfBackend, ocrLang),
		onEvent
	);
}

/** One spawn of convert.py per file (VC_CONVERT_WORKER=0), classified into done / error / native crash. */
function runConvertAttemptSpawn(
	inPath: string,
	outDir: string,
	tool: string,
	onEvent?: (event: ConvertEvent) => void,
	sourceName?: string,
	pages?: string,
	pdfBackend?: 'hybrid',
	ocrLang?: string
): Promise<AttemptOutcome<ConvertEvent & { type: 'done' }>> {
	return new Promise((resolve, reject) => {
		const bin = pythonBin();
		const args = [CONVERT_PY, ...buildConvertArgs(inPath, outDir, tool, sourceName, pages, pdfBackend, ocrLang)];
		// convert.py's convert_with_pandoc/pandoc_not_installed_message check
		// PANDOC_BIN before falling back to a bare 'pandoc' PATH lookup — same
		// stale-server-PATH bug as pythonBin() above, see pandoc-bin.ts's doc
		// comment. Only set when actually resolved so an unset PANDOC_BIN
		// doesn't shadow whatever (if anything) convert.py's own `shutil.which`
		// fallback would otherwise have found.
		const pandocBin = resolvePandocBin();
		const child = spawn(bin, args, {
			windowsHide: true,
			env: convertProcessEnv(pandocBin)
		});

		let lastDone: (ConvertEvent & { type: 'done' }) | null = null;
		let lastError: string | null = null;
		let lastErrorCode: ReturnType<typeof forwardedConvertCode> = null;
		let timedOut = false;
		let currentTimeoutMs = PROCESS_TIMEOUT_MS;

		let timer = setTimeout(() => {
			timedOut = true;
			child.kill();
		}, currentTimeoutMs);

		const rl = readline.createInterface({ input: child.stdout });
		rl.on('line', (line) => {
			if (!line.trim()) return;
			let event: ConvertEvent;
			try {
				event = JSON.parse(line);
			} catch {
				return; // non-JSON stdout noise — ignore rather than crash the stream
			}
			// Aşama 7: convert.py's early pageCount event (PDFs only) replaces
			// the flat startup-hang floor with a budget sized to this document
			// — a page count of 0 means pdf_page_count() itself failed
			// (malformed PDF), which is exactly when the floor should stay in
			// effect rather than collapse to just the base.
			if (event.type === 'progress' && event.pageCount) {
				clearTimeout(timer);
				currentTimeoutMs = pdfTimeoutMs(event.pageCount);
				timer = setTimeout(() => {
					timedOut = true;
					child.kill();
				}, currentTimeoutMs);
				event.estimatedSeconds = pdfEstimatedSeconds(event.pageCount);
			}
			onEvent?.(event);
			if (event.type === 'done') lastDone = event;
			if (event.type === 'error') {
				lastError = event.message;
				lastErrorCode = forwardedConvertCode(event.code);
			}
		});

		let stderr = '';
		child.stderr.on('data', (chunk) => {
			stderr += chunk.toString();
		});

		child.on('error', (err) => {
			clearTimeout(timer);
			reject(new AppError('PYTHON_SPAWN_FAILED', { detail: err.message }));
		});

		child.on('exit', (code, signal) => {
			clearTimeout(timer);
			if (timedOut) {
				// Checked first — a killed process exits with lastDone/lastError
				// both still null in the common case, but a race is possible (the
				// process finished writing its `done` line just as the timer
				// fired) and would otherwise report success on a run that was
				// actually killed for running too long.
				resolve({
					kind: 'error',
					error: new AppError('PROCESS_TIMEOUT', { seconds: Math.round(currentTimeoutMs / 1000) })
				});
			} else if (lastDone) {
				// Also covers a crash AFTER `done` (the process dying while it shuts
				// down) — the result was already delivered, so it counts as success.
				resolve({ kind: 'done', value: lastDone });
			} else if (lastError) {
				// Only allow-listed codes pass through; anything else Python sends
				// stays a generic CONVERSION_FAILED.
				resolve({
					kind: 'error',
					error: new AppError(lastErrorCode ?? 'CONVERSION_FAILED', lastErrorCode ? undefined : { detail: lastError })
				});
			} else if (isNativeCrash(code, signal)) {
				resolve({ kind: 'crash', detail: `exit ${code ?? signal}: ${stderr.slice(-300) || 'no stderr'}` });
			} else {
				resolve({
					kind: 'error',
					error: new AppError('CONVERSION_FAILED', { detail: `exit ${code}: ${stderr.slice(0, 500) || 'bilinmeyen hata'}` })
				});
			}
		});
	});
}

/**
 * System-wide queue — conversion is CPU-bound and can be slow (especially
 * once Marker/Docling are added later); the skill doc is explicit that the
 * user's RAM/CPU belongs to Ollama first, so by default only one conversion
 * runs at a time regardless of how many uploads arrive at once.
 * Shares `sharedJobMutex` with Faz 6's Ollama model-swap logic — a model
 * load/unload and a running conversion must never overlap either. A
 * conversion takes a SHARED slot (sharedJobMutex.runShared): several may
 * overlap up to `concurrency`, but never an exclusive job (model swap,
 * YouTube/web/link import), and a queued exclusive job blocks conversions
 * queued after it, so a chat model swap waits only for the files already
 * running, not the whole batch.
 *
 * `concurrency` (batch import's "parallel processing", default 1 = exactly
 * the old serial behavior; the batch endpoint clamps it to 1..4): whole
 * files run in parallel, not pages — in `auto` mode the converter is only
 * chosen inside convert.py, so the server cannot size per-tool limits.
 *
 * `exclusiveGpu` (batch import): before this conversion starts, unload every
 * idle Ollama model (only when Ollama is configured — see gpu-evict.ts) so
 * docling has the 6 GB card to itself — measured (Aşama 7) at roughly 3x
 * slower when qwen3 is resident. Runs while holding a shared slot, which is
 * safe: see ollamaGate.evictAllForExclusiveJob.
 *
 * Antivirus (TODO #60): every file is scanned HERE, before it takes a queue slot or reaches convert.py, so one call covers
 * single, batch, link (stage-url) and MCP imports. A threat rejects with FILE_THREAT_DETECTED; no scanner / a failed scan
 * lets the import proceed (see av-guard.ts). `skipAvScan` is for re-conversions of an original that was already scanned
 * when it was first imported (api/library/reimport), so a file is never scanned twice.
 */
export async function enqueueConversion(
	inPath: string,
	outDir: string,
	tool: string,
	onEvent?: (event: ConvertEvent) => void,
	sourceName?: string,
	pages?: string,
	opts: { exclusiveGpu?: boolean; concurrency?: number; ocrLang?: string; skipAvScan?: boolean } = {}
): Promise<ConvertEvent & { type: 'done' }> {
	if (!opts.skipAvScan) await assertFileClean(inPath);
	return sharedJobMutex.runShared(async () => {
		if (opts.exclusiveGpu) await evictForExclusiveJob();
		return runConvert(inPath, outDir, tool, onEvent, sourceName, pages, opts.ocrLang);
	}, opts.concurrency ?? 1);
}
