import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

/**
 * Pure, injectable Python interpreter resolution (the Windows logic moved
 * here verbatim from convertQueue.ts's old resolvePythonBin(); read its
 * history for the WindowsApps / OEM-codepage reasoning). scripts/doctor.mjs
 * carries a standalone mirror of resolvePythonBin() — keep both in sync.
 *
 * POSIX matters because a GUI-launched desktop app inherits a minimal PATH
 * (macOS: /usr/bin:/bin:/usr/sbin:/sbin), so Homebrew / python.org / pyenv
 * interpreters are invisible to a bare `python3` lookup. Order:
 *   1. PYTHON_BIN
 *   2. the app-owned venv (<dataDir>/python-venv)
 *   3. python3 found by scanning PATH ourselves
 *   4. well-known install locations
 * Windows adds the Python bundled with the installer (dist-server/python,
 * TODO #53) and one invariant: a Python that has docling (several GB with
 * torch/CUDA) is never shadowed by one that doesn't, or the user would
 * re-download it. Windows order:
 *   1. PYTHON_BIN
 *   2. the app venv, if it has docling
 *   3. a system interpreter that has docling
 *   4. the app venv (no docling)
 *   5. the bundled Python
 *   6. any other system interpreter, then bare `python`
 * "Has docling" is a filesystem probe (see pythonHasDocling), not a process
 * spawn: this runs on the hot path of every conversion and every status call,
 * and `python -c "import docling"` costs seconds (torch import).
 * On macOS, /usr/bin/python3 is a shim that pops an "install developer
 * tools" dialog when the Command Line Tools are missing, so it is skipped
 * (also when found through PATH) unless CLT or Xcode is present.
 */

export const MIN_PYTHON = { major: 3, minor: 10 } as const;
export const VENV_DIRNAME = 'python-venv';

export interface PythonResolveDeps {
	platform: NodeJS.Platform;
	env: NodeJS.ProcessEnv;
	home: string;
	/** Absolute data directory, or null when unknown (no venv lookup). */
	dataDir: string | null;
	exists: (p: string) => boolean;
	readdir: (p: string) => string[];
	/** Windows: absolute path of the bundled interpreter (may not exist: dev
	 * runs, older layouts). Unset/null elsewhere. */
	bundledPython?: string | null;
}

export function defaultPythonDeps(dataDirPath: string | null): PythonResolveDeps {
	return {
		platform: process.platform,
		env: process.env,
		home: os.homedir(),
		dataDir: dataDirPath,
		exists: fs.existsSync,
		readdir: (p) => fs.readdirSync(p),
		bundledPython: process.platform === 'win32' ? bundledPythonPath(process.cwd()) : null
	};
}

/** Bundled interpreter inside a server root. The packaged sidecar's cwd IS the
 * server root (src-tauri/src/lib.rs: current_dir(server_dir), the same
 * assumption convertQueue.ts makes for ingest/*.py), so no env var is needed;
 * scripts/fetch-python-runtime.mjs puts python.exe at <root>/python/python.exe. */
export function bundledPythonPath(serverRoot: string): string {
	return path.win32.join(serverRoot, 'python', 'python.exe');
}

/** The bundled interpreter when it is actually on disk, else null. */
export function existingBundledPython(d: PythonResolveDeps): string | null {
	return d.bundledPython && d.exists(d.bundledPython) ? d.bundledPython : null;
}

/**
 * Windows: does this interpreter's own prefix carry the docling package?
 * Probes <prefix>\Lib\site-packages\docling (prefix = the exe's folder, or the
 * folder above a `Scripts` dir for venvs), plus the per-user site
 * (%APPDATA%\Python\Python3XY\site-packages\docling, where `pip install --user`
 * lands). The per-user probe cannot know the interpreter's X.Y without
 * spawning it, so any Python3* folder counts; that only widens a system
 * interpreter's match and never applies to venvs (they ignore user site).
 * Always false off Windows: POSIX keeps its plain order.
 */
export function pythonHasDocling(d: PythonResolveDeps, exe: string): boolean {
	if (d.platform !== 'win32') return false;
	const p = path.win32;
	let dir = p.dirname(exe);
	const isVenv = p.basename(dir).toLowerCase() === 'scripts';
	if (isVenv) dir = p.dirname(dir);
	if (d.exists(p.join(dir, 'Lib', 'site-packages', 'docling'))) return true;
	if (isVenv || !d.env.APPDATA) return false;
	const userBase = p.join(d.env.APPDATA, 'Python');
	if (!d.exists(userBase)) return false;
	return d
		.readdir(userBase)
		.some((n) => /^Python3\d+$/.test(n) && d.exists(p.join(userBase, n, 'site-packages', 'docling')));
}

const MAC_CLT_PYTHON = '/Library/Developer/CommandLineTools/usr/bin/python3';
const MAC_XCODE_DEVELOPER = '/Applications/Xcode.app/Contents/Developer';

function flavor(platform: NodeJS.Platform) {
	return platform === 'win32' ? path.win32 : path.posix;
}

/** Path of the app-owned venv's interpreter (may not exist yet). */
export function venvPythonPath(dataDirPath: string, platform: NodeJS.Platform = process.platform): string {
	const p = flavor(platform);
	return platform === 'win32'
		? p.join(dataDirPath, VENV_DIRNAME, 'Scripts', 'python.exe')
		: p.join(dataDirPath, VENV_DIRNAME, 'bin', 'python3');
}

export function venvDirPath(dataDirPath: string, platform: NodeJS.Platform = process.platform): string {
	return flavor(platform).join(dataDirPath, VENV_DIRNAME);
}

function macDevToolsPresent(d: PythonResolveDeps): boolean {
	return d.exists(MAC_CLT_PYTHON) || d.exists(MAC_XCODE_DEVELOPER);
}

function winCandidates(d: PythonResolveDeps): string[] {
	const p = path.win32;
	const out: string[] = [];
	const pathDirs = (d.env.PATH ?? '').split(p.delimiter).filter(Boolean);
	for (const dir of pathDirs) {
		if (dir.toLowerCase().includes('windowsapps')) continue;
		const exe = p.join(dir, 'python.exe');
		if (d.exists(exe)) out.push(exe);
	}
	const programsDir = p.join(d.home, 'AppData', 'Local', 'Programs', 'Python');
	if (d.exists(programsDir)) {
		// Numeric sort, not lexicographic ("Python312" < "Python39" as strings).
		const versions = d
			.readdir(programsDir)
			.filter((n) => /^Python3\d+$/.test(n))
			.sort((a, b) => Number(b.slice(6)) - Number(a.slice(6)));
		for (const v of versions) {
			const exe = p.join(programsDir, v, 'python.exe');
			if (d.exists(exe)) out.push(exe);
		}
	}
	return out;
}

function posixCandidates(d: PythonResolveDeps): string[] {
	const p = path.posix;
	const mac = d.platform === 'darwin';
	const devTools = mac ? macDevToolsPresent(d) : true;
	const out: string[] = [];
	const push = (exe: string) => {
		if (mac && exe === '/usr/bin/python3' && !devTools) return;
		if (!out.includes(exe)) out.push(exe);
	};
	for (const dir of (d.env.PATH ?? '').split(p.delimiter).filter(Boolean)) {
		const exe = p.join(dir, 'python3');
		if (d.exists(exe)) push(exe);
	}
	const known = ['/opt/homebrew/bin/python3', '/usr/local/bin/python3'];
	if (mac) known.push('/Library/Frameworks/Python.framework/Versions/Current/bin/python3');
	known.push('/usr/bin/python3');
	for (const exe of known) if (d.exists(exe)) push(exe);
	return out;
}

/** Every system interpreter candidate in resolution order, EXCLUDING
 * PYTHON_BIN and the app venv (used to pick a base interpreter for venv
 * creation, and by resolvePythonBin below). */
export function systemPythonCandidates(d: PythonResolveDeps): string[] {
	return d.platform === 'win32' ? winCandidates(d) : posixCandidates(d);
}

export function resolvePythonBin(d: PythonResolveDeps = defaultPythonDeps(null)): string {
	if (d.env.PYTHON_BIN) return d.env.PYTHON_BIN;
	const venvPy = d.dataDir && d.exists(venvPythonPath(d.dataDir, d.platform)) ? venvPythonPath(d.dataDir, d.platform) : null;
	const system = systemPythonCandidates(d);
	// Docling-first (Windows only, pythonHasDocling is false elsewhere): see the header comment.
	if (venvPy && pythonHasDocling(d, venvPy)) return venvPy;
	const withDocling = system.find((exe) => pythonHasDocling(d, exe));
	if (withDocling) return withDocling;
	if (venvPy) return venvPy;
	const bundled = existingBundledPython(d);
	if (bundled) return bundled;
	const first = system[0];
	if (first) return first;
	return d.platform === 'win32' ? 'python' : 'python3'; // last resort
}

// --- Version ---------------------------------------------------------------

export interface PythonVersion {
	major: number;
	minor: number;
	patch: number;
}

/** Parses "Python 3.12.0rc2" / "Python 3.9.6" (stdout or stderr of --version). */
export function parsePythonVersion(text: string): PythonVersion | null {
	const m = /Python\s+(\d+)\.(\d+)(?:\.(\d+))?/i.exec(text);
	if (!m) return null;
	return { major: Number(m[1]), minor: Number(m[2]), patch: m[3] ? Number(m[3]) : 0 };
}

export function isPythonVersionSupported(v: PythonVersion): boolean {
	return v.major > MIN_PYTHON.major || (v.major === MIN_PYTHON.major && v.minor >= MIN_PYTHON.minor);
}

export interface PythonVersionCheck {
	/** Interpreter ran and printed a parsable version. */
	ok: boolean;
	version: PythonVersion | null;
	raw: string;
	supported: boolean;
}

const VERSION_TIMEOUT_MS = 5000;

export function checkPythonVersion(bin: string, timeoutMs = VERSION_TIMEOUT_MS): Promise<PythonVersionCheck> {
	return new Promise((resolve) => {
		execFile(bin, ['--version'], { timeout: timeoutMs, windowsHide: true, encoding: 'utf-8' }, (err, stdout, stderr) => {
			const raw = (String(stdout ?? '').trim() || String(stderr ?? '').trim());
			const version = err ? null : parsePythonVersion(raw);
			resolve({ ok: !err && version !== null, version, raw, supported: version ? isPythonVersionSupported(version) : false });
		});
	});
}

export function formatPythonVersion(v: PythonVersion): string {
	return `${v.major}.${v.minor}.${v.patch}`;
}

/** First candidate that runs and is >= MIN_PYTHON; otherwise the first
 * candidate that merely runs; otherwise null. `check` is injectable. */
export async function pickSupportedPython(
	candidates: string[],
	check: (bin: string) => Promise<PythonVersionCheck> = checkPythonVersion
): Promise<{ bin: string; check: PythonVersionCheck } | null> {
	let fallback: { bin: string; check: PythonVersionCheck } | null = null;
	for (const bin of candidates) {
		const c = await check(bin);
		if (!c.ok) continue;
		if (c.supported) return { bin, check: c };
		fallback ??= { bin, check: c };
	}
	return fallback;
}

// --- Venv commands (pure argv builders) --------------------------------------

export function venvCreateCommand(systemPython: string, venvDir: string): { bin: string; args: string[] } {
	return { bin: systemPython, args: ['-m', 'venv', venvDir] };
}

export function pipInstallCommand(venvPython: string, requirementsTxt: string): { bin: string; args: string[] } {
	return { bin: venvPython, args: ['-m', 'pip', 'install', '-r', requirementsTxt] };
}

/** True when the venv failure output points at the missing `venv`/ensurepip
 * module (Debian/Ubuntu ship it in a separate python3-venv package). */
export function isVenvModuleMissing(output: string): boolean {
	return /No module named venv|ensurepip is not available|python3(\.\d+)?-venv|No module named ensurepip/i.test(output);
}
