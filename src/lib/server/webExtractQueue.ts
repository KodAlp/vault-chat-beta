import { spawn } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import { sharedJobMutex } from './jobMutex';
import { pythonBin, type ConvertEvent } from './convertQueue';
import { AppError } from './app-error';

const EXTRACT_WEB_PY = path.resolve(process.cwd(), 'ingest', 'extract_web.py');

// Pathological page (infinite redirect chain trafilatura chases internally,
// a huge malformed document) must not hang the shared queue forever — it's
// shared with Ollama model-swap (sharedJobMutex), so a stuck child here
// blocks chat too. Mirrors the same guard added to convertQueue.ts's
// runConvert for the same reason.
const PROCESS_TIMEOUT_MS = 120_000;

function runExtractWeb(
	inPath: string,
	url: string,
	outDir: string,
	onEvent?: (event: ConvertEvent) => void
): Promise<ConvertEvent & { type: 'done' }> {
	return new Promise((resolve, reject) => {
		const bin = pythonBin();
		const child = spawn(bin, [EXTRACT_WEB_PY, '--in', inPath, '--url', url, '--out-dir', outDir], {
			windowsHide: true
		});

		let lastDone: (ConvertEvent & { type: 'done' }) | null = null;
		let lastError: string | null = null;
		let timedOut = false;

		const timer = setTimeout(() => {
			timedOut = true;
			child.kill();
		}, PROCESS_TIMEOUT_MS);

		const rl = readline.createInterface({ input: child.stdout });
		rl.on('line', (line) => {
			if (!line.trim()) return;
			let event: ConvertEvent;
			try {
				event = JSON.parse(line);
			} catch {
				return; // non-JSON stdout noise — ignore rather than crash the stream
			}
			onEvent?.(event);
			if (event.type === 'done') lastDone = event;
			if (event.type === 'error') lastError = event.message;
		});

		let stderr = '';
		child.stderr.on('data', (chunk) => {
			stderr += chunk.toString();
		});

		child.on('error', (err) => {
			clearTimeout(timer);
			reject(new AppError('PYTHON_SPAWN_FAILED', { detail: err.message }));
		});

		child.on('exit', (code) => {
			clearTimeout(timer);
			if (timedOut) {
				reject(new AppError('PROCESS_TIMEOUT', { seconds: Math.round(PROCESS_TIMEOUT_MS / 1000) }));
			} else if (lastDone) {
				resolve(lastDone);
			} else if (lastError) {
				reject(new AppError('CONVERSION_FAILED', { detail: lastError }));
			} else {
				reject(new AppError('CONVERSION_FAILED', { detail: `exit ${code}: ${stderr.slice(0, 500) || 'bilinmeyen hata'}` }));
			}
		});
	});
}

/**
 * System-wide sequential queue, same reasoning as enqueueConversion —
 * shares sharedJobMutex so extraction never overlaps a running PDF
 * conversion or an Ollama model load/unload.
 */
export function enqueueWebExtract(
	inPath: string,
	url: string,
	outDir: string,
	onEvent?: (event: ConvertEvent) => void
): Promise<ConvertEvent & { type: 'done' }> {
	return sharedJobMutex.run(() => runExtractWeb(inPath, url, outDir, onEvent));
}
