import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

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
 * resolve to a real, absolute interpreter path once, at module load.
 */
function resolvePythonBin(): string {
	if (process.env.PYTHON_BIN) return process.env.PYTHON_BIN;
	if (process.platform !== 'win32') return 'python3';

	try {
		// where.exe's redirected stdout is the OS's OEM codepage (e.g. CP857 on
		// a Turkish locale), not UTF-8 — decoding non-ASCII path segments (a
		// username with a Turkish İ, say) as utf-8 silently corrupts them into
		// a string that *looks* right but isn't byte-identical, so spawn()
		// later fails with ENOENT on a path fs.existsSync would call valid.
		// Never trust the decoded text without verifying it against the real
		// filesystem first.
		const out = execFileSync('where', ['python'], { encoding: 'utf-8' });
		const real = out
			.split(/\r?\n/)
			.map((l) => l.trim())
			.filter(Boolean)
			.find((p) => !p.toLowerCase().includes('windowsapps') && fs.existsSync(p));
		if (real) return real;
	} catch {
		// `where` can fail outright (e.g. python not on PATH at all) — fall
		// through to probing known install locations directly.
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

const PYTHON_BIN = resolvePythonBin();
const CONVERT_PY = path.resolve(process.cwd(), 'ingest', 'convert.py');

/**
 * Runs one conversion (never in parallel — see queue below). Rejects with a
 * readable message on failure; never leaves the caller staring at a hung
 * process or a raw stack trace.
 */
function runConvert(
	inPath: string,
	outDir: string,
	tool: string,
	onEvent?: (event: ConvertEvent) => void
): Promise<ConvertEvent & { type: 'done' }> {
	return new Promise((resolve, reject) => {
		const child = spawn(PYTHON_BIN, [CONVERT_PY, '--in', inPath, '--out-dir', outDir, '--tool', tool], {
			windowsHide: true
		});

		let lastDone: (ConvertEvent & { type: 'done' }) | null = null;
		let lastError: string | null = null;

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
			reject(new Error(`Python başlatılamadı (${PYTHON_BIN} kurulu mu?): ${err.message}`));
		});

		child.on('exit', (code) => {
			if (lastDone) {
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
 */
let queueTail: Promise<unknown> = Promise.resolve();

export function enqueueConversion(
	inPath: string,
	outDir: string,
	tool: string,
	onEvent?: (event: ConvertEvent) => void
): Promise<ConvertEvent & { type: 'done' }> {
	const task = queueTail.then(
		() => runConvert(inPath, outDir, tool, onEvent),
		() => runConvert(inPath, outDir, tool, onEvent)
	);
	// Swallow rejection for chaining purposes only — the real result/error
	// still propagates to this call's own caller via the returned `task`.
	queueTail = task.catch(() => undefined);
	return task;
}
