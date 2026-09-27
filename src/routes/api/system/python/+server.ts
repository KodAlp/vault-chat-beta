import fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { pythonBin } from '$lib/server/convertQueue';
import { sseStream } from '$lib/server/sse';
import { logAppEvent } from '$lib/server/app-log';
import { AppError, errorPayload } from '$lib/server/app-error';
import { parseRequirementsImportNames, buildModuleCheckScript } from '$lib/server/pythonModules';
import type { PythonModuleStatus, PythonSetupEvent, PythonSystemStatus } from '$lib/types';

const REQUIREMENTS_TXT = path.resolve(process.cwd(), 'ingest', 'requirements.txt');

/** Hard cap on the pandoc/module-check child processes below — a hung or
 * missing binary must never leave this request open forever the way a
 * bare spawnSync() with no timeout would. 5s is generous for a `--version`
 * or a handful of `import` statements; anything past that is not going to
 * finish. */
const CHECK_TIMEOUT_MS = 5000;

function checkPandocInstalled(): boolean {
	try {
		const result = spawnSync('pandoc', ['--version'], { timeout: CHECK_TIMEOUT_MS, windowsHide: true });
		return !result.error && result.status === 0;
	} catch {
		return false;
	}
}

/** Runs every requirements.txt import in ONE python process (a small
 * generated `-c` script — see buildModuleCheckScript) rather than one spawn
 * per module, and maps the parsed JSON result back onto each module's
 * dist name for the UI (a user searches for "py-asciimath" on PyPI, not
 * "py_asciimath"). Any failure (python missing, script crashed, unparsable
 * output) reports every module as not installed rather than throwing —
 * this only ever backs an informational status endpoint. */
function checkModules(bin: string): PythonModuleStatus[] {
	const specs = parseRequirementsImportNames(fs.readFileSync(REQUIREMENTS_TXT, 'utf-8'));
	const script = buildModuleCheckScript(specs.map((s) => s.importName));
	const result = spawnSync(bin, ['-c', script], { timeout: CHECK_TIMEOUT_MS });
	let parsed: Record<string, boolean> = {};
	if (!result.error && result.status === 0) {
		try {
			parsed = JSON.parse(result.stdout.toString('utf-8')) as Record<string, boolean>;
		} catch {
			parsed = {};
		}
	}
	return specs.map((s) => ({ name: s.importName, installed: parsed[s.importName] === true }));
}

/** Same detection primitive as scripts/doctor.mjs's markitdown/yt_dlp check
 * (`spawnSync(pythonBin, ['-c', 'import <pkg>'])`, exit 0 = installed),
 * exposed over HTTP here since doctor.mjs is a standalone CLI script with
 * no route into the running server.
 *
 * Aşama 2b: extended with `modules` (every import in ingest/requirements.txt,
 * checked in one python process — see checkModules) and `pandoc` (optional,
 * never a banner trigger — see PythonStatusBanner). `pythonInstalled` and
 * `markitdownInstalled` are kept for backward compat with any existing
 * caller that only reads those two fields. */
export const GET: RequestHandler = async () => {
	const bin = pythonBin();
	const versionCheck = spawnSync(bin, ['--version'], { timeout: CHECK_TIMEOUT_MS });
	const pythonInstalled = !versionCheck.error && versionCheck.status === 0;
	const pythonVersion = pythonInstalled
		? (versionCheck.stdout.toString('utf-8').trim() || versionCheck.stderr.toString('utf-8').trim() || null)
		: null;

	const modules = pythonInstalled ? checkModules(bin) : [];
	const markitdownInstalled = modules.find((m) => m.name === 'markitdown')?.installed ?? false;
	const pandoc = checkPandocInstalled();

	const status: PythonSystemStatus = { pythonInstalled, pythonVersion, markitdownInstalled, modules, pandoc };
	return json(status);
};

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
