// Stages a production-only copy of the built server into dist-server/, for
// tauri.conf.json's bundle.resources to pick up. Kept separate from
// `npm run build` (which produces the dev-friendly `build/` used by `node
// build` directly) so the packaged app never ships vite/typescript/
// svelte-check/tsx/@tauri-apps/cli — `npm ci --omit=dev` inside a *copy* of
// package.json, not the real node_modules, is what achieves that.
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { requiredNodeMajor, verifyStagedData } from './stage-verify.mjs';
import { fetchPythonRuntime } from './fetch-python-runtime.mjs';
import { buildMcpBundle, MCP_BUNDLE_RELATIVE } from './build-mcp.mjs';

const root = process.cwd();
const stageDir = path.join(root, 'dist-server');

function sleepSync(ms) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * node:fs's rmSync/cpSync both hit Windows-specific failures on this
 * machine for recursive directory operations under a path containing
 * non-ASCII characters (this repo's path has Turkish letters) — a known
 * class of Node/Windows long-path-prefix bug (cpSync: EIO; rmSync: EBUSY,
 * even though PowerShell's Remove-Item deletes the same directory
 * instantly right after — not a real external lock). PowerShell handles
 * both directions reliably, so it's used here instead of node:fs.
 *
 * Without -ErrorAction Stop, though, Remove-Item treats a locked file (a
 * transient antivirus/indexer scan on a just-installed npm package, seen
 * in practice on this machine) as a non-terminating error: it prints a
 * warning, skips that file, and keeps going — and the wrapping
 * `powershell.exe -Command` process still exits 0, so execFileSync never
 * throws. dist-server/ then looks removed to this script while some of
 * its files are still on disk, and the `npm ci` below runs against that
 * not-actually-clean node_modules — which is exactly how a stale esbuild
 * binary ended up mismatched against a fresh package.json one build.
 * -ErrorAction Stop turns the same lock into a real thrown error here;
 * existsSync() after is the actual ground truth regardless of what the
 * process exit code claims.
 */
function removeStageDirOrThrow(target = stageDir) {
	if (process.platform !== 'win32') {
		// The PowerShell workaround below is for a Windows non-ASCII path bug; elsewhere plain fs is reliable.
		rmSync(target, { recursive: true, force: true });
		if (existsSync(target)) throw new Error(`${path.relative(root, target) || target} temizlenemedi: ${target}`);
		return;
	}
	for (let attempt = 1; attempt <= 2; attempt++) {
		if (!existsSync(target)) return;
		try {
			execFileSync(
				'powershell',
				['-NoProfile', '-Command', `Remove-Item -Path "${target}" -Recurse -Force -ErrorAction Stop`],
				{ stdio: 'inherit' }
			);
		} catch {
			// fall through to the existsSync() check below — a lock that
			// clears on retry is the common case, not this catch itself
		}
		if (!existsSync(target)) return;
		if (attempt === 1) {
			console.log(`${path.relative(root, target)} silinemedi (muhtemelen geçici bir dosya kilidi) — tekrar deneniyor...`);
			sleepSync(2000);
		}
	}
	throw new Error(
		`dist-server/ klasörü temizlenemedi: ${target}\n` +
			'Muhtemelen bir antivirüs/indeksleme aracı içindeki bir dosyayı kilitli tutuyor. ' +
			'Klasörü elle silip tekrar deneyin, ya da o aracı geçici olarak durdurun.'
	);
}

// --- npm ci atlama (#57) ---
// `npm ci` her sahnelemede ~dakikalar sürer; package.json + package-lock.json (ve better-sqlite3'ün
// yerel ikilisinin bağlı olduğu Node sürümü/platform/mimari) değişmediyse önceki sahnelemenin
// node_modules'ı birebir aynı olur. Güvenlik: damga dosyası YALNIZCA npm ci + rebuild BAŞARIYLA
// bittikten sonra yazılır (yarım kalmış kurulum asla "geçerli" sayılmaz), ve node_modules dışındaki
// her şey (build/, ingest/, data/) her seferinde silinip baştan kopyalanır — yalnız node_modules
// yeniden kullanılır. Zorla temiz kurulum: STAGE_FORCE_INSTALL=1 ya da --force-install.
const STAMP_NAME = '.npm-ci-stamp';
const stampPath = path.join(stageDir, STAMP_NAME);
const nodeModulesDir = path.join(stageDir, 'node_modules');
const forceInstall = process.env.STAGE_FORCE_INSTALL === '1' || process.argv.includes('--force-install');
const depsKey = createHash('sha256')
	.update(readFileSync(path.join(root, 'package-lock.json')))
	.update('\0')
	.update(readFileSync(path.join(root, 'package.json')))
	.update('\0' + [process.version, process.platform, process.arch].join('|'))
	.digest('hex');
const nativeBinaryExists = () =>
	existsSync(path.join(nodeModulesDir, 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node'));
const canReuseNodeModules =
	!forceInstall &&
	existsSync(stampPath) &&
	existsSync(nodeModulesDir) &&
	nativeBinaryExists() &&
	readFileSync(stampPath, 'utf8').trim() === depsKey;

if (canReuseNodeModules) {
	// node_modules ve damga dışındaki her şeyi temizle (dosya dosya, aynı kilit-dayanıklı silme ile).
	for (const entry of readdirSync(stageDir)) {
		if (entry === 'node_modules' || entry === STAMP_NAME) continue;
		removeStageDirOrThrow(path.join(stageDir, entry));
	}
} else {
	removeStageDirOrThrow();
}
mkdirSync(stageDir, { recursive: true });

function copyDir(src, dest, excludeDirs = []) {
	if (process.platform !== 'win32') {
		// Equivalent of robocopy /E /XD <names>: copy everything, skipping directories with those names at any depth.
		cpSync(src, dest, {
			recursive: true,
			filter: (s) => !(excludeDirs.includes(path.basename(s)) && statSync(s).isDirectory())
		});
		return;
	}
	mkdirSync(dest, { recursive: true });
	// robocopy's exit codes 0-7 are all "success" (bit flags for what
	// changed); only >=8 is a real failure, hence the manual check instead
	// of relying on execFileSync's default zero-exit-code assumption. A null
	// status means robocopy never ran (spawn failure) — that is a failure too,
	// never "nothing to do".
	const xd = excludeDirs.length > 0 ? ['/XD', ...excludeDirs] : [];
	const r = spawnSync('robocopy', [src, dest, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NC', '/NS', ...xd], {
		stdio: 'inherit'
	});
	if (r.error || r.status === null || r.status >= 8) {
		throw new Error(`robocopy başarısız (status=${r.status}${r.error ? `, ${r.error.message}` : ''}): ${src}`);
	}
}

copyDir(path.join(root, 'build'), path.join(stageDir, 'build'));
// ingest/ (convert.py, youtube_transcript.py, postprocess.py, requirements.txt)
// was never staged here — convertQueue.ts/youtubeQueue.ts resolve their
// scripts as path.resolve(process.cwd(), 'ingest', ...), and the packaged
// sidecar's cwd IS server_dir (dist-server), so document/YouTube import
// silently failed in the installed desktop app even with Python installed.
copyDir(path.join(root, 'ingest'), path.join(stageDir, 'ingest'), ['__pycache__', '.venv']);
copyFileSync(path.join(root, 'package.json'), path.join(stageDir, 'package.json'));
copyFileSync(path.join(root, 'package-lock.json'), path.join(stageDir, 'package-lock.json'));
mkdirSync(path.join(stageDir, 'data'), { recursive: true });
// Ship the DEFAULT config (data/providers.default.json), never the working copy's data/providers.json —
// that one is the developer's own (enabled cloud providers, personal model picks, chains, embedding
// choice). src-tauri/src/lib.rs seeds the user's app-data providers.json from this staged copy on first
// launch only. verifyStagedData() below proves it landed byte-identical and that nothing else from
// data/ came along.
copyFileSync(path.join(root, 'data', 'providers.default.json'), path.join(stageDir, 'data', 'providers.json'));

console.log('Installing production-only dependencies in dist-server/...');
/**
 * --ignore-scripts, not a plain `npm ci --omit=dev`: bits-ui -> runed has a
 * peerOptional on @sveltejs/kit, which pulls vite (and vite's own nested,
 * older esbuild) into the tree as "devOptional" even under --omit=dev —
 * `npm ci` still writes and runs its postinstall regardless of the omit
 * flags. That nested esbuild@0.25.12's install.js does its own binary
 * version check, and on this machine it reads back the *other*,
 * unrelated top-level esbuild's 0.28.1 binary instead of its own — the
 * same class of long/non-ASCII-path Windows bug documented above for
 * rmSync/cpSync, just hitting a postinstall script's own path resolution
 * this time. None of vite/esbuild/@sveltejs/kit are ever imported by the
 * packaged server (SvelteKit's adapter-node output in build/ is
 * self-contained), so skipping install scripts entirely is safe — except
 * better-sqlite3, the one production dependency whose postinstall is load-
 * bearing (compiles/fetches its native .node binary), rebuilt explicitly
 * right after.
 */
if (canReuseNodeModules) {
	console.log(
		'npm ci atlandı: package-lock.json/package.json ve Node sürümü değişmedi, dist-server/node_modules yeniden kullanılıyor ' +
			'(zorla temiz kurulum için STAGE_FORCE_INSTALL=1 ya da --force-install).'
	);
} else {
	execFileSync('npm', ['ci', '--omit=dev', '--ignore-scripts'], { cwd: stageDir, stdio: 'inherit', shell: true });
	execFileSync('npm', ['rebuild', 'better-sqlite3'], { cwd: stageDir, stdio: 'inherit', shell: true });
	writeFileSync(stampPath, depsKey + '\n');
}

// Self-contained MCP server (plain `node`, no tsx/devDependencies) for the Settings "connect an MCP client"
// card. Built after the production install because its externals (better-sqlite3, sqlite-vec) resolve from
// dist-server/node_modules; everything else, @modelcontextprotocol/sdk included, is bundled in.
const mcpBundle = await buildMcpBundle({ root, outDir: stageDir });
console.log(`MCP bundle: ${path.relative(root, mcpBundle.outfile)} (${(mcpBundle.size / 1024).toFixed(0)} KiB)`);

// Windows only (#53): the installer carries its own Node and Python so the user installs neither. macOS/Linux
// keep resolving a system Node/Python.
if (process.platform === 'win32') {
	// Node: this very process's node.exe. better-sqlite3 in dist-server/node_modules was (re)built by this same
	// Node a few lines above (or by the identical Node recorded in the npm-ci stamp's depsKey), so the native
	// addon's ABI matches the bundled runtime by construction; src-tauri/src/lib.rs always runs this copy.
	const requiredMajor = requiredNodeMajor(JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).engines?.node);
	const buildMajor = Number(process.versions.node.split('.')[0]);
	if (requiredMajor === null || buildMajor !== requiredMajor) {
		console.error(`Gömülecek Node ana sürümü ${requiredMajor ?? '?'} olmalı (package.json engines.node); bu makinedeki Node ${process.version}.`);
		process.exit(1);
	}
	mkdirSync(path.join(stageDir, 'node'), { recursive: true });
	copyFileSync(process.execPath, path.join(stageDir, 'node', 'node.exe'));
	// A standard Node install keeps LICENSE beside node.exe; a bare/portable copy may not (see THIRD_PARTY_NOTICES.md).
	const nodeLicense = path.join(path.dirname(process.execPath), 'LICENSE');
	if (existsSync(nodeLicense)) copyFileSync(nodeLicense, path.join(stageDir, 'node', 'LICENSE'));
	else console.warn('Uyarı: Node LICENSE dosyası node.exe yanında yok; THIRD_PARTY_NOTICES.md bildirimine güveniliyor.');
	console.log(`Node ${process.version} -> dist-server/node/node.exe`);
	await fetchPythonRuntime({ root, stageDir });
}

const readIfExists = (p) => (existsSync(p) ? readFileSync(p) : null);
const stagedProblems = verifyStagedData({
	stagedProviders: readIfExists(path.join(stageDir, 'data', 'providers.json')),
	defaultProviders: readIfExists(path.join(root, 'data', 'providers.default.json')),
	stagedDataEntries: readdirSync(path.join(stageDir, 'data')),
	stagedBuildIndexExists: existsSync(path.join(stageDir, 'build', 'index.js')),
	stagedConvertPyExists: existsSync(path.join(stageDir, 'ingest', 'convert.py')),
	stagedMcpBundleExists: existsSync(path.join(stageDir, MCP_BUNDLE_RELATIVE)),
	stagedNodeExists: process.platform === 'win32' ? existsSync(path.join(stageDir, 'node', 'node.exe')) : null,
	stagedPythonExists: process.platform === 'win32' ? existsSync(path.join(stageDir, 'python', 'python.exe')) : null
});
if (stagedProblems.length > 0) {
	console.error('Sahneleme doğrulaması başarısız:');
	for (const problem of stagedProblems) console.error('  - ' + problem);
	process.exit(1);
}

console.log('dist-server/ staged.');
