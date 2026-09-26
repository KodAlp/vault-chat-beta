import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { pythonBin } from '$lib/server/convertQueue';
import { sseStream } from '$lib/server/sse';
import { logAppEvent } from '$lib/server/app-log';
import { AppError, errorPayload } from '$lib/server/app-error';
import type { PythonSetupEvent } from '$lib/types';

/** Same detection primitive as scripts/doctor.mjs's markitdown/yt_dlp check
 * (`spawnSync(pythonBin, ['-c', 'import <pkg>'])`, exit 0 = installed),
 * exposed over HTTP here since doctor.mjs is a standalone CLI script with
 * no route into the running server. */
export const GET: RequestHandler = async () => {
	const bin = pythonBin();
	const versionCheck = spawnSync(bin, ['--version']);
	const pythonInstalled = !versionCheck.error && versionCheck.status === 0;

	let markitdownInstalled = false;
	if (pythonInstalled) {
		const importCheck = spawnSync(bin, ['-c', 'import markitdown']);
		markitdownInstalled = importCheck.status === 0;
	}

	return json({ pythonInstalled, markitdownInstalled });
};

const REQUIREMENTS_TXT = path.resolve(process.cwd(), 'ingest', 'requirements.txt');

/** Runs `python -m pip install -r ingest/requirements.txt` and streams its
 * output live — same sseStream shell /api/import uses for the other
 * long-running child process in this app, so a client that navigates away
 * mid-install can't crash the server the way a bare ReadableStream did
 * before sse.ts existed (see sse.ts's doc comment). `-m pip`, not a bare
 * `pip` binary, for the same "don't trust a bare PATH lookup on Windows"
 * reasoning as resolvePythonBin() itself. */
export const POST: RequestHandler = async () => {
	const bin = pythonBin();
	const versionCheck = spawnSync(bin, ['--version']);
	if (versionCheck.error || versionCheck.status !== 0) {
		return sseStream<PythonSetupEvent>(async (send) => {
			send({ type: 'error', ...errorPayload(new AppError('PYTHON_NOT_FOUND')) });
		});
	}

	return sseStream<PythonSetupEvent>(async (send) => {
		await new Promise<void>((resolve) => {
			const child = spawn(bin, ['-m', 'pip', 'install', '-r', REQUIREMENTS_TXT], {
				windowsHide: true
			});

			const forwardLines = (chunk: Buffer) => {
				for (const line of chunk.toString().split(/\r?\n/)) {
					if (line.trim()) send({ type: 'log', line });
				}
			};
			child.stdout.on('data', forwardLines);
			child.stderr.on('data', forwardLines);

			child.on('error', (err) => {
				send({ type: 'error', ...errorPayload(new AppError('PYTHON_SPAWN_FAILED', { detail: err.message })) });
				resolve();
			});

			child.on('exit', (code) => {
				send({ type: 'done', ok: code === 0 });
				resolve();
			});
		});
	}, (message) => logAppEvent({ kind: 'fatal_error', message: `python setup stream: ${message}` }));
};
