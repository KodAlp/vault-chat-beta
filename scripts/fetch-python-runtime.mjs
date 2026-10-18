// Windows only: puts a self-contained CPython at dist-server/python/ (python.exe directly inside) so the
// installed app no longer needs the user to install Python (TODO #53). python-build-standalone's
// `install_only_stripped` flavour is a plain relocatable tree (stdlib + venv + ensurepip/pip, no installer,
// no registry, no admin rights). The light packages of ingest/requirements.txt are deliberately NOT
// installed here: the app's "Şimdi kur" flow creates the app venv from this interpreter and pip-installs
// them on first use (src/routes/api/system/python/+server.ts).
//
// ONE exact release is pinned below. To upgrade: pick a release at
// https://github.com/astral-sh/python-build-standalone/releases, copy the cpython-3.12.x install_only_stripped
// x86_64-pc-windows-msvc file name and its line from that release's SHA256SUMS, update both constants.
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const PYTHON_RELEASE = '20261013';
export const PYTHON_VERSION = '3.12.15';
export const PYTHON_ARCHIVE = `cpython-${PYTHON_VERSION}+${PYTHON_RELEASE}-x86_64-pc-windows-msvc-install_only_stripped.tar.gz`;
export const PYTHON_SHA256 = '7a2aef48e5ee569e310b29b32681debbc5d888e92790d85331a47736c6b06aad';
export const PYTHON_URL = `https://github.com/astral-sh/python-build-standalone/releases/download/${PYTHON_RELEASE}/${encodeURIComponent(PYTHON_ARCHIVE)}`;

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
	const cacheDir = path.join(root, '.cache', 'runtimes');
	const archive = path.join(cacheDir, PYTHON_ARCHIVE);
	mkdirSync(cacheDir, { recursive: true });

	if (existsSync(archive) && sha256File(archive) !== PYTHON_SHA256) {
		console.log(`Önbellekteki ${PYTHON_ARCHIVE} bozuk, siliniyor.`);
		rmSync(archive, { force: true });
	}
	if (!existsSync(archive)) {
		console.log(`Python indiriliyor: ${PYTHON_URL}`);
		const res = await fetch(PYTHON_URL, { redirect: 'follow' });
		if (!res.ok) throw new Error(`Python indirilemedi: HTTP ${res.status} ${PYTHON_URL}`);
		const part = archive + '.part';
		writeFileSync(part, Buffer.from(await res.arrayBuffer()));
		const got = sha256File(part);
		if (got !== PYTHON_SHA256) {
			rmSync(part, { force: true });
			throw new Error(`Python arşivinin SHA256 değeri uyuşmuyor (beklenen ${PYTHON_SHA256}, gelen ${got}).`);
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
