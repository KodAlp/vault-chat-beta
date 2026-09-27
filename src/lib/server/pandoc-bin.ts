import fs from 'node:fs';
import path from 'node:path';

/**
 * Resolves an absolute path to a real pandoc binary instead of trusting a
 * bare `pandoc` PATH lookup — same reasoning as convertQueue.ts's
 * resolvePythonBin() (read that function's doc comment first): a long-running
 * Node server process can be holding a stale PATH from before pandoc was
 * installed (winget's default install location,
 * `%LOCALAPPDATA%\Pandoc\pandoc.exe`, is not on PATH until the shell/session
 * that launched the server is restarted), so `spawnSync('pandoc', ...)` keeps
 * reporting "not installed" for the rest of that server process's lifetime
 * even right after a successful winget install. Scanning PATH ourselves and
 * then falling back to the known winget install locations sidesteps that
 * without requiring a restart.
 *
 * `env`/`existsSync`/`platform` are injectable purely for testing — every
 * real caller uses the defaults (`process.env`, `fs.existsSync`,
 * `process.platform`).
 */
export function resolvePandocBin(
	env: NodeJS.ProcessEnv = process.env,
	existsSync: (p: string) => boolean = fs.existsSync,
	platform: NodeJS.Platform = process.platform
): string | null {
	const isWin = platform === 'win32';
	// path.join()/path.delimiter default to the HOST OS Node is actually
	// running on, not the `platform` argument above — on a real Windows box
	// that stays true (path === path.win32) regardless, but it would
	// silently break a test that injects platform: 'linux' while running on
	// Windows (path.join would still emit backslashes). Picking the flavor
	// explicitly makes `platform` actually mean something, in prod and in
	// tests alike.
	const p = isWin ? path.win32 : path.posix;

	// An explicit override always wins, but only if it actually points at
	// something — a stale/typo'd PANDOC_BIN must fall through to the normal
	// search rather than silently making pandoc look missing.
	if (env.PANDOC_BIN && existsSync(env.PANDOC_BIN)) return env.PANDOC_BIN;

	if (!isWin) {
		const pathDirs = (env.PATH ?? '').split(p.delimiter).filter(Boolean);
		for (const dir of pathDirs) {
			if (existsSync(p.join(dir, 'pandoc'))) return 'pandoc';
		}
		return null;
	}

	// Scan PATH entries directly rather than shelling out to `where.exe` —
	// see resolvePythonBin()'s doc comment for why (OEM-codepage decoding of
	// a non-ASCII path segment silently breaks fs.existsSync() on the
	// result). process.env.PATH is already a correctly-decoded string from
	// Node itself.
	const pathDirs = (env.PATH ?? '').split(p.delimiter).filter(Boolean);
	for (const dir of pathDirs) {
		if (dir.toLowerCase().includes('windowsapps')) continue;
		const exe = p.join(dir, 'pandoc.exe');
		if (existsSync(exe)) return exe;
	}

	// PATH didn't have it — check winget's actual install locations directly.
	// JohnMacFarlane.Pandoc (the winget package this app's setup wizard
	// installs, see /setup/local-server) drops pandoc.exe under
	// %LOCALAPPDATA%\Pandoc by default; a system-wide/manual install more
	// commonly lands under %ProgramFiles%\Pandoc.
	const candidates: string[] = [];
	if (env.LOCALAPPDATA) candidates.push(p.join(env.LOCALAPPDATA, 'Pandoc', 'pandoc.exe'));
	if (env.ProgramFiles) candidates.push(p.join(env.ProgramFiles, 'Pandoc', 'pandoc.exe'));
	for (const exe of candidates) {
		if (existsSync(exe)) return exe;
	}

	return null;
}
