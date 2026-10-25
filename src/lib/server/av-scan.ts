import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Antivirus scan of ONE file on disk, before the converter ever opens it.
 *
 * Engines:
 *  - Windows: Microsoft Defender's command-line scanner, `MpCmdRun.exe -Scan -ScanType 3 -File <path> -DisableRemediation`
 *    (custom scan; never quarantines or deletes, the import is just refused).
 *  - Everywhere (Linux/macOS, and Windows as a second choice): ClamAV, `clamdscan` if present, else `clamscan`.
 *
 * Measured on a Windows 11 machine where a third-party AV had switched Defender off (AntivirusEnabled = False):
 * `MpCmdRun.exe -Scan -ScanType 3` on a harmless file exits with code 2 (not 0) and prints
 * "CmdTool: Failed with hr = 0x80004005". Exit 2 therefore means BOTH "threat found" and "could not scan", so the output
 * decides: a `Failed with hr` line = scanner unavailable, anything else on exit 2 = threat.
 *
 * Nothing here ever throws for a scanner problem: the result's `status` carries it, and the caller (av-guard.ts) owns the
 * policy (infected = reject, unavailable / error = import anyway and log).
 */
export type AvStatus = 'clean' | 'infected' | 'unavailable' | 'error';
export type AvEngine = 'defender' | 'clamav';

export interface AvScanResult {
	status: AvStatus;
	engine?: AvEngine;
	threat?: string;
	ms: number;
	/** Short diagnostic for 'unavailable' / 'error' (never file contents). */
	detail?: string;
}

export interface RunnerResult {
	/** Exit code; null when the process was killed (timeout) or never started. */
	code: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
	/** Set when the executable could not be started at all (ENOENT, EACCES). */
	spawnError?: string;
}

/** Runs an executable with an argument list (no shell). Injected in tests. */
export type AvRunner = (cmd: string, args: string[], timeoutMs: number) => Promise<RunnerResult>;

export interface AvScannerDeps {
	runner: AvRunner;
	platform: NodeJS.Platform;
	env: NodeJS.ProcessEnv;
	exists: (p: string) => boolean;
	listDir: (p: string) => string[];
	now: () => number;
}

export const DEFAULT_SCAN_TIMEOUT_MS = 60_000;
/** After an engine reports itself unavailable, skip it for this long so a 100-file batch spawns it once, not 100 times. */
export const UNAVAILABLE_RECHECK_MS = 60_000;

/** HRESULTs MpCmdRun prints when Defender is simply not the active scanner / not running. */
const DEFENDER_UNAVAILABLE_HR = new Set([
	'0x80004005', // generic failure: what a disabled Defender (third-party AV active) returned on the dev machine
	'0x800106ba', // service not running
	'0x80070422', // service disabled
	'0x800106b5',
	'0x8050800c',
	'0x80508023'
]);

export function runnerFromExecFile(cmd: string, args: string[], timeoutMs: number): Promise<RunnerResult> {
	return new Promise((resolve) => {
		execFile(
			cmd,
			args,
			{ timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' },
			(err, stdout, stderr) => {
				const out = String(stdout ?? '');
				const errText = String(stderr ?? '');
				if (!err) return resolve({ code: 0, stdout: out, stderr: errText, timedOut: false });
				const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null };
				if (typeof e.code === 'number') return resolve({ code: e.code, stdout: out, stderr: errText, timedOut: false });
				if (e.killed || e.signal) return resolve({ code: null, stdout: out, stderr: errText, timedOut: true });
				resolve({ code: null, stdout: out, stderr: errText, timedOut: false, spawnError: e.code ?? e.message });
			}
		);
	});
}

function defaultDeps(): AvScannerDeps {
	return {
		runner: runnerFromExecFile,
		platform: process.platform,
		env: process.env,
		exists: (p) => {
			try {
				return fs.statSync(p).isFile();
			} catch {
				return false;
			}
		},
		listDir: (p) => {
			try {
				return fs.readdirSync(p);
			} catch {
				return [];
			}
		},
		now: () => Date.now()
	};
}

/** Orders Defender platform folders such as `4.18.26050.15-0` newest first. */
export function comparePlatformFolders(a: string, b: string): number {
	const nums = (s: string) => s.split(/[.-]/).map((n) => Number.parseInt(n, 10) || 0);
	const x = nums(a);
	const y = nums(b);
	for (let i = 0; i < Math.max(x.length, y.length); i++) {
		const d = (y[i] ?? 0) - (x[i] ?? 0);
		if (d !== 0) return d;
	}
	return 0;
}

export function findMpCmdRun(deps: Pick<AvScannerDeps, 'env' | 'exists' | 'listDir'>): string | null {
	const programData = deps.env.ProgramData ?? deps.env.PROGRAMDATA;
	if (programData) {
		const platformDir = path.win32.join(programData, 'Microsoft', 'Windows Defender', 'Platform');
		const folders = deps.listDir(platformDir).sort(comparePlatformFolders);
		for (const f of folders) {
			const candidate = path.win32.join(platformDir, f, 'MpCmdRun.exe');
			if (deps.exists(candidate)) return candidate;
		}
	}
	const programFiles = deps.env.ProgramFiles ?? deps.env.PROGRAMFILES;
	if (programFiles) {
		const candidate = path.win32.join(programFiles, 'Windows Defender', 'MpCmdRun.exe');
		if (deps.exists(candidate)) return candidate;
	}
	return null;
}

export function findOnPath(name: string, deps: Pick<AvScannerDeps, 'env' | 'exists' | 'platform'>): string | null {
	const win = deps.platform === 'win32';
	const sep = win ? ';' : ':';
	const pathVar = deps.env.PATH ?? deps.env.Path ?? '';
	const exts = win ? ['.exe', '.cmd', '.bat'] : [''];
	for (const dir of pathVar.split(sep)) {
		if (!dir) continue;
		for (const ext of exts) {
			const candidate = (win ? path.win32 : path.posix).join(dir, name + ext);
			if (deps.exists(candidate)) return candidate;
		}
	}
	return null;
}

interface Engine {
	kind: AvEngine;
	bin: string;
	/** clamdscan (daemon) vs clamscan (loads the signature DB per run). */
	daemon?: boolean;
}

export function detectEngines(deps: AvScannerDeps): Engine[] {
	const engines: Engine[] = [];
	if (deps.platform === 'win32') {
		const mp = findMpCmdRun(deps);
		if (mp) engines.push({ kind: 'defender', bin: mp });
	}
	const clamd = findOnPath('clamdscan', deps);
	if (clamd) engines.push({ kind: 'clamav', bin: clamd, daemon: true });
	const clam = findOnPath('clamscan', deps);
	if (clam) engines.push({ kind: 'clamav', bin: clam });
	return engines;
}

/** Threat name from MpCmdRun output ("Threat                  : Virus:DOS/EICAR_Test_File"; localized label tolerated). */
export function parseDefenderThreat(stdout: string): string | undefined {
	const m = /^\s*(?:Threat|Tehdit)\s*:\s*(.+?)\s*$/im.exec(stdout);
	return m ? m[1] : undefined;
}

export function parseClamThreat(stdout: string): string | undefined {
	const m = /:\s*(.+?)\s+FOUND\s*$/im.exec(stdout);
	return m ? m[1] : undefined;
}

type EngineOutcome = Omit<AvScanResult, 'ms' | 'engine'>;

export function classifyDefender(r: RunnerResult): EngineOutcome {
	if (r.timedOut) return { status: 'error', detail: 'timeout' };
	if (r.spawnError) return { status: 'unavailable', detail: r.spawnError };
	const text = `${r.stdout}\n${r.stderr}`;
	if (r.code === 0) return { status: 'clean' };
	const failed = /Failed with hr\s*=\s*(0x[0-9a-f]+)/i.exec(text) ?? /\[Failed\]\[(0x[0-9a-f]+)\]/i.exec(text);
	if (failed) {
		const hr = failed[1].toLowerCase();
		return { status: DEFENDER_UNAVAILABLE_HR.has(hr) ? 'unavailable' : 'error', detail: `hr ${hr}` };
	}
	if (r.code === 2) return { status: 'infected', threat: parseDefenderThreat(r.stdout) ?? 'unknown' };
	return { status: 'error', detail: `exit ${r.code}` };
}

export function classifyClam(r: RunnerResult, daemon: boolean): EngineOutcome {
	if (r.timedOut) return { status: 'error', detail: 'timeout' };
	if (r.spawnError) return { status: 'unavailable', detail: r.spawnError };
	if (r.code === 0) return { status: 'clean' };
	if (r.code === 1) return { status: 'infected', threat: parseClamThreat(r.stdout) ?? 'unknown' };
	const text = `${r.stdout}\n${r.stderr}`;
	// clamdscan without a running clamd: not a scan failure, there is simply no scanner right now.
	if (daemon && /(can'?t connect|connection refused|no such file or directory|could not connect)/i.test(text)) {
		return { status: 'unavailable', detail: 'clamd not running' };
	}
	return { status: 'error', detail: `exit ${r.code}` };
}

export interface AvScanner {
	scanFile(filePath: string, opts?: { timeoutMs?: number }): Promise<AvScanResult>;
	/** Forget the cached engine detection and "unavailable" verdicts. */
	reset(): void;
}

/** A scanner with its own cache. Production uses the default one below; tests inject runner/env. */
export function createAvScanner(overrides: Partial<AvScannerDeps> = {}): AvScanner {
	const deps: AvScannerDeps = { ...defaultDeps(), ...overrides };
	let engines: Engine[] | null = null;
	const unavailableUntil = new Map<string, number>();

	return {
		reset() {
			engines = null;
			unavailableUntil.clear();
		},
		async scanFile(filePath, opts = {}) {
			const started = deps.now();
			const timeoutMs = opts.timeoutMs ?? DEFAULT_SCAN_TIMEOUT_MS;
			const done = (r: Omit<AvScanResult, 'ms'>): AvScanResult => ({ ...r, ms: deps.now() - started });

			if (!engines) engines = detectEngines(deps);
			if (engines.length === 0) return done({ status: 'unavailable', detail: 'no scanner installed' });

			const abs = path.resolve(filePath);
			let last: AvScanResult | null = null;
			for (const engine of engines) {
				const key = `${engine.kind}:${engine.bin}`;
				const skipUntil = unavailableUntil.get(key) ?? 0;
				if (skipUntil > deps.now()) {
					last ??= done({ status: 'unavailable', engine: engine.kind, detail: 'recently unavailable' });
					continue;
				}
				let outcome: EngineOutcome;
				if (engine.kind === 'defender') {
					const r = await deps.runner(
						engine.bin,
						['-Scan', '-ScanType', '3', '-File', abs, '-DisableRemediation'],
						timeoutMs
					);
					outcome = classifyDefender(r);
				} else {
					const args = engine.daemon
						? ['--no-summary', '--fdpass', abs]
						: ['--no-summary', abs];
					const r = await deps.runner(engine.bin, args, timeoutMs);
					outcome = classifyClam(r, engine.daemon === true);
				}
				if (outcome.status === 'unavailable') {
					unavailableUntil.set(key, deps.now() + UNAVAILABLE_RECHECK_MS);
					last = done({ ...outcome, engine: engine.kind });
					continue;
				}
				return done({ ...outcome, engine: engine.kind });
			}
			return last ?? done({ status: 'unavailable', detail: 'no scanner available' });
		}
	};
}

const defaultScanner = createAvScanner();

/** Scans one file with whatever engine this machine has. See the module comment for the result semantics. */
export function scanFile(filePath: string, opts?: { timeoutMs?: number }): Promise<AvScanResult> {
	return defaultScanner.scanFile(filePath, opts);
}

export function resetAvScanCache(): void {
	defaultScanner.reset();
}
