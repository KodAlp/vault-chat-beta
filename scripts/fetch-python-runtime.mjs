// Windows only: puts a self-contained CPython at dist-server/python/ (python.exe directly inside) so the
// installed app no longer needs the user to install Python. python-build-standalone's
// `install_only_stripped` flavour is a plain relocatable tree (stdlib + venv + ensurepip/pip, no installer,
// no registry, no admin rights). The light packages of ingest/requirements.txt are deliberately NOT
// installed here: the app's "Şimdi kur" flow creates the app venv from this interpreter and pip-installs
// them on first use (src/routes/api/system/python/+server.ts).
//
// ONE exact release is pinned below, for both Windows architectures (x64 and ARM64; the archive matches the
// Node running the staging, i.e. the architecture the installer is built for). To upgrade: pick a release at
// https://github.com/astral-sh/python-build-standalone/releases and copy the x86_64- and aarch64-pc-windows-msvc
// install_only_stripped lines from that release's SHA256SUMS into PYTHON_SHA256.
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const PYTHON_RELEASE = '20261013';
export const PYTHON_VERSION = '3.12.15';
export const PYTHON_SHA256 = {
	x86_64: '7a2aef48e5ee569e310b29b32681debbc5d888e92790d85331a47736c6b06aad',
	aarch64: '864342350eec45119bf295d7af7d60a36842e1c6d181cce760fcc6f60e5a072a'
};

/** python-build-standalone's triple prefix for a Node `process.arch`; other architectures are not built for Windows. */
export function pythonArch(arch = process.arch) {
	if (arch === 'x64') return 'x86_64';
	if (arch === 'arm64') return 'aarch64';
	throw new Error(`Gömülü Python için desteklenmeyen mimari: ${arch} (yalnız x64 ve arm64)`);
}

export function pythonArchive(arch = process.arch) {
	return `cpython-${PYTHON_VERSION}+${PYTHON_RELEASE}-${pythonArch(arch)}-pc-windows-msvc-install_only_stripped.tar.gz`;
}

function pythonUrl(archiveName) {
	return `https://github.com/astral-sh/python-build-standalone/releases/download/${PYTHON_RELEASE}/${encodeURIComponent(archiveName)}`;
}

function sha256File(file) {
	return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/** Windows' built-in bsdtar. A GNU tar earlier on PATH (Git Bash) misreads `C:\...` as a remote host. */
function windowsTar() {
	const systemTar = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
	return existsSync(systemTar) ? systemTar : 'tar';
}

/**
 * Downloads (cached under <root>/.cache/runtimes/, gitignored), verifies the pinned SHA256 (hard failure on a
 * mismatch, the bad file is deleted) and extracts into <stageDir>/python/. Returns the python.exe path.
 */
export async function fetchPythonRuntime({ root, stageDir }) {
	if (process.platform !== 'win32') throw new Error('fetch-python-runtime.mjs is Windows-only');
	const archiveName = pythonArchive();
	const expectedSha = PYTHON_SHA256[pythonArch()];
	const url = pythonUrl(archiveName);
	const cacheDir = path.join(root, '.cache', 'runtimes');
	const archive = path.join(cacheDir, archiveName);
	mkdirSync(cacheDir, { recursive: true });

	if (existsSync(archive) && sha256File(archive) !== expectedSha) {
		console.log(`Önbellekteki ${archiveName} bozuk, siliniyor.`);
		rmSync(archive, { force: true });
	}
	if (!existsSync(archive)) {
		console.log(`Python indiriliyor: ${url}`);
		const res = await fetch(url, { redirect: 'follow' });
		if (!res.ok) throw new Error(`Python indirilemedi: HTTP ${res.status} ${url}`);
		const part = archive + '.part';
		writeFileSync(part, Buffer.from(await res.arrayBuffer()));
		const got = sha256File(part);
		if (got !== expectedSha) {
			rmSync(part, { force: true });
			throw new Error(`Python arşivinin SHA256 değeri uyuşmuyor (beklenen ${expectedSha}, gelen ${got}).`);
		}
		renameSync(part, archive);
	}

	const pythonDir = path.join(stageDir, 'python');
	rmSync(pythonDir, { recursive: true, force: true });
	// The archive's single top-level folder is `python/`.
	execFileSync(windowsTar(), ['-xzf', archive, '-C', stageDir], { stdio: 'inherit' });
	const pythonExe = path.join(pythonDir, 'python.exe');
	if (!existsSync(pythonExe)) throw new Error(`Arşiv açıldı ama ${pythonExe} yok.`);

	// ssl/sqlite3 are needed by pip and the importers, venv+ensurepip by "Şimdi kur" (venv creation).
	const smoke = spawnSync(pythonExe, ['-I', '-c', 'import ssl, sqlite3, venv, ensurepip'], { encoding: 'utf-8' });
	if (smoke.status !== 0) throw new Error(`Python duman testi başarısız: ${smoke.stderr || smoke.error}`);
	console.log(`Python ${PYTHON_VERSION} (python-build-standalone ${PYTHON_RELEASE}) -> ${path.relative(root, pythonDir)}`);
	return pythonExe;
}
