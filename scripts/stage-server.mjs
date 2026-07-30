// Stages a production-only copy of the built server into dist-server/, for
// tauri.conf.json's bundle.resources to pick up. Kept separate from
// `npm run build` (which produces the dev-friendly `build/` used by `node
// build` directly) so the packaged app never ships vite/typescript/
// svelte-check/tsx/@tauri-apps/cli — `npm ci --omit=dev` inside a *copy* of
// package.json, not the real node_modules, is what achieves that.
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const root = process.cwd();
const stageDir = path.join(root, 'dist-server');

/**
 * node:fs's rmSync/cpSync both hit Windows-specific failures on this
 * machine for recursive directory operations under a path containing
 * non-ASCII characters (this repo's path has Turkish letters) — a known
 * class of Node/Windows long-path-prefix bug (cpSync: EIO; rmSync: EBUSY,
 * even though PowerShell's Remove-Item deletes the same directory
 * instantly right after — not a real external lock). PowerShell handles
 * both directions reliably, so both go through it instead of node:fs.
 */
if (existsSync(stageDir)) {
	execFileSync(
		'powershell',
		['-NoProfile', '-Command', `Remove-Item -Path "${stageDir}" -Recurse -Force`],
		{ stdio: 'inherit' }
	);
}
mkdirSync(stageDir, { recursive: true });

function copyDirWindows(src, dest) {
	mkdirSync(dest, { recursive: true });
	// robocopy's exit codes 0-7 are all "success" (bit flags for what
	// changed); only >=8 is a real failure, hence the manual check instead
	// of relying on execFileSync's default zero-exit-code assumption.
	try {
		execFileSync('robocopy', [src, dest, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NC', '/NS'], {
			stdio: 'inherit'
		});
	} catch (err) {
		const code = err.status ?? 0;
		if (code >= 8) throw err;
	}
}

copyDirWindows(path.join(root, 'build'), path.join(stageDir, 'build'));
copyFileSync(path.join(root, 'package.json'), path.join(stageDir, 'package.json'));
copyFileSync(path.join(root, 'package-lock.json'), path.join(stageDir, 'package-lock.json'));
mkdirSync(path.join(stageDir, 'data'), { recursive: true });
copyFileSync(path.join(root, 'data', 'providers.json'), path.join(stageDir, 'data', 'providers.json'));

console.log('Installing production-only dependencies in dist-server/...');
execFileSync('npm', ['ci', '--omit=dev'], { cwd: stageDir, stdio: 'inherit', shell: true });

console.log('dist-server/ staged.');
