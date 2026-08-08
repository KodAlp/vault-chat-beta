import { spawn } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import { pythonBin } from './convertQueue';
import { sharedJobMutex } from './jobMutex';

export type YoutubeEvent =
	| { type: 'progress'; stage: string }
	| { type: 'done'; outPath: string | null; frontmatter: Record<string, unknown>; warnings: string[] }
	| { type: 'error'; message: string };

const YOUTUBE_TRANSCRIPT_PY = path.resolve(process.cwd(), 'ingest', 'youtube_transcript.py');

/** Same shape as convertQueue.ts's runConvert() — NDJSON stdout, explicit
 * child.on('error'/'exit') classification. Never runs in parallel with a
 * document conversion or an Ollama model swap (see sharedJobMutex below). */
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
			reject(new Error(`Python başlatılamadı (${bin} kurulu mu?): ${err.message}`));
		});

		child.on('exit', (code) => {
			if (lastDone) {
				resolve(lastDone);
			} else if (lastError) {
				reject(new Error(lastError));
			} else {
				reject(new Error(`Transkript alınamadı (exit ${code}): ${stderr.slice(0, 500) || 'bilinmeyen hata'}`));
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
