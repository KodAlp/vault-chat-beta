import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { sharedJobMutex } from './jobMutex';

export type ConvertEvent =
	| { type: 'progress'; stage: string }
	| { type: 'done'; outPath: string | null; frontmatter: Record<string, unknown>; warnings: string[] }
	| { type: 'error'; message: string };

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
function resolvePythonBin(): string {
	if (process.env.PYTHON_BIN) return process.env.PYTHON_BIN;
	if (process.platform !== 'win32') return 'python3';

	// Scan PATH entries directly instead of shelling out to `where.exe` —
	// `where`'s redirected stdout comes back in the OS's OEM codepage (e.g.
	// CP857 on a Turkish locale), not UTF-8, so a non-ASCII path segment (a
	// username with a Turkish İ, say — this repo's own path is exactly that
	// case) decodes into a string that *looks* right but isn't byte-identical
	// to the real path, and fs.existsSync() on it always comes back false.
	// process.env.PATH is already a correctly-decoded string from Node
	// itself, so this sidesteps the codepage layer entirely.
	const pathDirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
	for (const dir of pathDirs) {
		if (dir.toLowerCase().includes('windowsapps')) continue;
		const exe = path.join(dir, 'python.exe');
		if (fs.existsSync(exe)) return exe;
	}

	const programsDir = path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Python');
	if (fs.existsSync(programsDir)) {
		// Numeric sort, not lexicographic: "Python312" < "Python39" as plain
		// strings (('1' < '9'), which would silently prefer 3.9 over 3.12 —
		// picking whichever interpreter happens to NOT have markitdown
		// installed, since pip installs to whichever `python` a shell resolves
		// to, not necessarily the newest.
		const versions = fs
			.readdirSync(programsDir)
			.filter((d) => /^Python3\d+$/.test(d))
			.sort((a, b) => Number(b.slice(6)) - Number(a.slice(6)));
		for (const v of versions) {
			const exe = path.join(programsDir, v, 'python.exe');
			if (fs.existsSync(exe)) return exe;
		}
	}

	return 'python'; // last resort — no worse than the original behavior
}

// Lazy + memoized, not resolved at module load — env.ts's own "every
// accessor is a function" rule (see its doc comment): a caller that sets
// process.env.PYTHON_BIN before importing this module (a test, a bootstrap
// script) must not lose to a value this module already captured at import
// time.
let cachedPythonBin: string | null = null;
/** Exported so youtubeQueue.ts's yt-dlp sidecar reuses the exact same
 * Windows path-resolution fixes instead of a second, driftable copy —
 * see resolvePythonBin()'s doc comment for the bugs this avoids. */
export function pythonBin(): string {
	if (cachedPythonBin === null) cachedPythonBin = resolvePythonBin();
	return cachedPythonBin;
}

const CONVERT_PY = path.resolve(process.cwd(), 'ingest', 'convert.py');

// A malformed/adversarial PDF (more likely once Faz 15 feeds this from
// arbitrary downloaded links, not just the user's own uploads) can hang
// MarkItDown indefinitely. sharedJobMutex is shared with Ollama model-swap,
// so a stuck child here blocks chat too — never wait forever.
const PROCESS_TIMEOUT_MS = 120_000;

/**
 * Runs one conversion (never in parallel — see queue below). Rejects with a
 * readable message on failure; never leaves the caller staring at a hung
 * process or a raw stack trace.
 */
function runConvert(
	inPath: string,
	outDir: string,
	tool: string,
	onEvent?: (event: ConvertEvent) => void,
	sourceName?: string
): Promise<ConvertEvent & { type: 'done' }> {
	return new Promise((resolve, reject) => {
		const bin = pythonBin();
		const args = [CONVERT_PY, '--in', inPath, '--out-dir', outDir, '--tool', tool];
		// The real filename (E5/K2-5) — every caller stages the input under a
		// generic name ("original.pdf") to keep the staging dir collision-free,
		// which is why convert.py can no longer be trusted to know its own
		// source_file/title fallback from --in alone. See convert.py's module
		// docstring for the "original"/"input" title bug this fixes.
		if (sourceName) args.push('--source-name', sourceName);
		const child = spawn(bin, args, {
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
			reject(new Error(`Python başlatılamadı (${bin} kurulu mu?): ${err.message}`));
		});

		child.on('exit', (code) => {
			clearTimeout(timer);
			if (timedOut) {
				// Checked first — a killed process exits with lastDone/lastError
				// both still null in the common case, but a race is possible (the
				// process finished writing its `done` line just as the timer
				// fired) and would otherwise report success on a run that was
				// actually killed for running too long.
				reject(new Error(`Dönüştürme zaman aşımına uğradı (>${PROCESS_TIMEOUT_MS / 1000}s)`));
			} else if (lastDone) {
				resolve(lastDone);
			} else if (lastError) {
				reject(new Error(lastError));
			} else {
				reject(new Error(`Dönüştürme başarısız (exit ${code}): ${stderr.slice(0, 500) || 'bilinmeyen hata'}`));
			}
		});
	});
}

/**
 * System-wide sequential queue — conversion is CPU-bound and can be slow
 * (especially once Marker/Docling are added later); the skill doc is
 * explicit that the user's RAM/CPU belongs to Ollama first, so only one
 * conversion runs at a time regardless of how many uploads arrive at once.
 * Shares `sharedJobMutex` with Faz 6's Ollama model-swap logic — a model
 * load/unload and a running conversion must never overlap either.
 */
export function enqueueConversion(
	inPath: string,
	outDir: string,
	tool: string,
	onEvent?: (event: ConvertEvent) => void,
	sourceName?: string
): Promise<ConvertEvent & { type: 'done' }> {
	return sharedJobMutex.run(() => runConvert(inPath, outDir, tool, onEvent, sourceName));
}
