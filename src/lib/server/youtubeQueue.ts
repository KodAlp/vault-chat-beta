import { spawn } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import { pythonBin } from './convertQueue';
import { sharedJobMutex } from './jobMutex';
import { AppError } from './app-error';

export type YoutubeEvent =
	| { type: 'progress'; stage: string }
	| { type: 'done'; outPath: string | null; frontmatter: Record<string, unknown>; warnings: string[] }
	| { type: 'error'; message: string };

const YOUTUBE_TRANSCRIPT_PY = path.resolve(process.cwd(), 'ingest', 'youtube_transcript.py');

// yt-dlp can hang — a slow/unresponsive network path, or (before the
// `noplaylist` fix in youtube_transcript.py) a playlist URL that used to
// walk every video in the list. sharedJobMutex is shared with Ollama
// model-swap and document conversion, so a stuck child here locks out chat
// too — never wait forever. Mirrors convertQueue.ts/webExtractQueue.ts's
// identical guard (measured 2026-09-23: this queue was the one process
// spawner in the app with no timeout at all).
const PROCESS_TIMEOUT_MS = 120_000;

/** Same shape as convertQueue.ts's runConvert() — NDJSON stdout, explicit
 * child.on('error'/'exit') classification, timeout+kill. Never runs in
 * parallel with a document conversion or an Ollama model swap (see
 * sharedJobMutex below). */
function runYoutubeTranscript(
	url: string,
	outDir: string,
	lang: string,
	onEvent?: (event: YoutubeEvent) => void
): Promise<YoutubeEvent & { type: 'done' }> {
	return new Promise((resolve, reject) => {
		const bin = pythonBin();
		const child = spawn(bin, [YOUTUBE_TRANSCRIPT_PY, '--url', url, '--out-dir', outDir, '--lang', lang], {
			windowsHide: true
		});

		let lastDone: (YoutubeEvent & { type: 'done' }) | null = null;
		let lastError: string | null = null;
		let timedOut = false;

		const timer = setTimeout(() => {
			timedOut = true;
			child.kill();
		}, PROCESS_TIMEOUT_MS);

		const rl = readline.createInterface({ input: child.stdout });
		rl.on('line', (line) => {
			if (!line.trim()) return;
			let event: YoutubeEvent;
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
				reject(new AppError('TRANSCRIPT_FAILED', { detail: lastError }));
			} else {
				reject(new AppError('TRANSCRIPT_FAILED', { detail: `exit ${code}: ${stderr.slice(0, 500) || 'bilinmeyen hata'}` }));
			}
		});
	});
}

/** Shares sharedJobMutex with document conversion and Ollama model-swap —
 * see convertQueue.ts's enqueueConversion() doc comment for why only one
 * of these ever runs at a time. */
export function enqueueYoutubeTranscript(
	url: string,
	outDir: string,
	onEvent?: (event: YoutubeEvent) => void
): Promise<YoutubeEvent & { type: 'done' }> {
	return sharedJobMutex.run(() => runYoutubeTranscript(url, outDir, 'tr,en', onEvent));
}
