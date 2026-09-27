import fs from 'node:fs';
import { execFile, spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { pythonBin } from '$lib/server/convertQueue';
import { resolvePandocBin } from '$lib/server/pandoc-bin';
import { sseStream } from '$lib/server/sse';
import { logAppEvent } from '$lib/server/app-log';
import { AppError, errorPayload } from '$lib/server/app-error';
import { parseRequirementsImportNames, buildModuleCheckScript } from '$lib/server/pythonModules';
import type { PythonModuleStatus, PythonSetupEvent, PythonSystemStatus } from '$lib/types';

const REQUIREMENTS_TXT = path.resolve(process.cwd(), 'ingest', 'requirements.txt');

/** Hard cap on the pandoc/module-check child processes below — a hung or
 * missing binary must never leave this request open forever the way a
 * bare spawnSync() with no timeout would. 5s is generous for a `--version`;
 * anything past that is not going to finish. */
const CHECK_TIMEOUT_MS = 5000;
/** The module import check needs far more: markitdown[all] pulls in a heavy
 * dependency tree, and importing all requirements took 4.7s even with a
 * warm cache on the dev machine — a cold start blew past 5s, the process
 * was killed, and every module (markitdown included) was reported missing
 * although all were installed. */
const MODULE_CHECK_TIMEOUT_MS = 30000;

/** Async, never spawnSync: this endpoint runs on every app load (the Python
 * banner) and the module import check alone takes ~9s on the dev machine —
 * a synchronous spawn blocks Node's event loop for that whole time, so every
 * other request (chat streams included) stalls behind it. */
function run(bin: string, args: string[], timeout: number): Promise<{ ok: boolean; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		execFile(bin, args, { timeout, windowsHide: true, encoding: 'utf-8' }, (err, stdout, stderr) => {
			resolve({ ok: !err, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
		});
	});
}

async function checkPandocInstalled(): Promise<boolean> {
	// A bare 'pandoc' PATH lookup can miss a just-installed pandoc — see
	// pandoc-bin.ts's doc comment for why (stale PATH held by this
	// long-running server process).
	const bin = resolvePandocBin();
	if (!bin) return false;
	return (await run(bin, ['--version'], CHECK_TIMEOUT_MS)).ok;
}

/** Runs every requirements.txt import in ONE python process (a small
 * generated `-c` script — see buildModuleCheckScript) rather than one spawn
 * per module, and maps the parsed JSON result back onto each module's
 * dist name for the UI (a user searches for "py-asciimath" on PyPI, not
 * "py_asciimath"). Any failure (python missing, script crashed, unparsable
 * output) reports every module as not installed rather than throwing —
 * this only ever backs an informational status endpoint. */
async function checkModules(bin: string): Promise<PythonModuleStatus[]> {
	const specs = parseRequirementsImportNames(fs.readFileSync(REQUIREMENTS_TXT, 'utf-8'));
	const script = buildModuleCheckScript(specs.map((s) => s.importName));
	const result = await run(bin, ['-c', script], MODULE_CHECK_TIMEOUT_MS);
	let parsed: Record<string, boolean> = {};
	if (result.ok) {
		try {
			// Last line only: a module can print warnings to stdout on import.
			const lastLine = result.stdout.trim().split(/\r?\n/).pop() ?? '';
			parsed = JSON.parse(lastLine) as Record<string, boolean>;
		} catch {
			parsed = {};
		}
	}
	return specs.map((s) => ({ name: s.importName, installed: parsed[s.importName] === true }));
}

async function computeStatus(): Promise<PythonSystemStatus> {
	const bin = pythonBin();
	const [versionCheck, pandoc] = await Promise.all([run(bin, ['--version'], CHECK_TIMEOUT_MS), checkPandocInstalled()]);
	const pythonInstalled = versionCheck.ok;
	const pythonVersion = pythonInstalled ? versionCheck.stdout.trim() || versionCheck.stderr.trim() || null : null;
	const modules = pythonInstalled ? await checkModules(bin) : [];
	const markitdownInstalled = modules.find((m) => m.name === 'markitdown')?.installed ?? false;
	return { pythonInstalled, pythonVersion, markitdownInstalled, modules, pandoc };
}

/** Cached because the check costs ~10s and nothing it measures changes on
 * its own mid-session. Concurrent callers share one in-flight check. The
 * cache is dropped after a pip install (POST below) and bypassed with
 * `?fresh=1`, which the setup wizard sends right after a winget install. */
const STATUS_TTL_MS = 10 * 60 * 1000;
let cached: { at: number; status: Promise<PythonSystemStatus> } | null = null;

function invalidateStatus() {
	cached = null;
}

function getStatus(fresh: boolean): Promise<PythonSystemStatus> {
	if (fresh || !cached || Date.now() - cached.at > STATUS_TTL_MS) {
		const status = computeStatus();
		cached = { at: Date.now(), status };
		// A failed check must not be served from cache for ten minutes.
		status.catch(() => invalidateStatus());
	}
	return cached.status;
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
export const GET: RequestHandler = async ({ url }) => {
	return json(await getStatus(url.searchParams.get('fresh') === '1'));
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
				invalidateStatus();
				send({ type: 'done', ok: code === 0 });
				resolve();
			});
		});
	}, (message) => logAppEvent({ kind: 'fatal_error', message: `python setup stream: ${message}` }));
};
