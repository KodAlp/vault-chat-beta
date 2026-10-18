import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	resolvePythonBin,
	parsePythonVersion,
	isPythonVersionSupported,
	venvPythonPath,
	pythonHasDocling,
	bundledPythonPath,
	venvCreateCommand,
	pipInstallCommand,
	pickSupportedPython,
	isVenvModuleMissing,
	type PythonResolveDeps,
	type PythonVersionCheck
} from './python-bin';

function deps(over: Partial<PythonResolveDeps> & { files?: string[]; dirs?: Record<string, string[]> }): PythonResolveDeps {
	const files = new Set(over.files ?? []);
	return {
		platform: 'linux',
		env: { PATH: '/usr/bin:/bin' },
		home: '/home/alp',
		dataDir: '/data',
		exists: (p) => files.has(p),
		readdir: (p) => over.dirs?.[p] ?? [],
		...over
	};
}

const CLT = '/Library/Developer/CommandLineTools/usr/bin/python3';

test('PYTHON_BIN wins over everything', () => {
	const d = deps({ env: { PYTHON_BIN: '/x/py', PATH: '/usr/bin' }, files: ['/data/python-venv/bin/python3', '/usr/bin/python3'] });
	assert.equal(resolvePythonBin(d), '/x/py');
});

test('app venv is preferred over PATH python3 (posix)', () => {
	const d = deps({ files: ['/data/python-venv/bin/python3', '/usr/bin/python3'] });
	assert.equal(resolvePythonBin(d), '/data/python-venv/bin/python3');
});

test('linux: python3 found on PATH', () => {
	const d = deps({ env: { PATH: '/home/alp/.pyenv/shims:/usr/bin' }, files: ['/home/alp/.pyenv/shims/python3', '/usr/bin/python3'] });
	assert.equal(resolvePythonBin(d), '/home/alp/.pyenv/shims/python3');
});

test('linux: minimal PATH falls back to known locations in order', () => {
	const d = deps({ env: { PATH: '/nowhere' }, files: ['/usr/local/bin/python3', '/usr/bin/python3'] });
	assert.equal(resolvePythonBin(d), '/usr/local/bin/python3');
});

test('linux: nothing found returns bare python3', () => {
	assert.equal(resolvePythonBin(deps({ env: { PATH: '' } })), 'python3');
});

test('darwin with CLT: PATH order wins; Homebrew found when PATH is minimal', () => {
	const d = deps({
		platform: 'darwin',
		env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
		files: ['/opt/homebrew/bin/python3', '/usr/bin/python3', CLT]
	});
	assert.equal(resolvePythonBin(d), '/usr/bin/python3');
	const d2 = deps({ platform: 'darwin', env: { PATH: '/bin' }, files: ['/opt/homebrew/bin/python3', '/usr/bin/python3', CLT] });
	assert.equal(resolvePythonBin(d2), '/opt/homebrew/bin/python3');
});

test('darwin without CLT: /usr/bin/python3 skipped on PATH and as known location', () => {
	const d = deps({ platform: 'darwin', env: { PATH: '/usr/bin:/bin' }, files: ['/usr/bin/python3'] });
	assert.equal(resolvePythonBin(d), 'python3');
	const d2 = deps({
		platform: 'darwin',
		env: { PATH: '/usr/bin:/bin' },
		files: ['/usr/bin/python3', '/Library/Frameworks/Python.framework/Versions/Current/bin/python3']
	});
	assert.equal(resolvePythonBin(d2), '/Library/Frameworks/Python.framework/Versions/Current/bin/python3');
});

test('darwin with Xcode developer dir allows /usr/bin/python3', () => {
	const d = deps({ platform: 'darwin', env: { PATH: '/bin' }, files: ['/usr/bin/python3', '/Applications/Xcode.app/Contents/Developer'] });
	assert.equal(resolvePythonBin(d), '/usr/bin/python3');
});

test('linux does not apply the macOS /usr/bin shim rule', () => {
	const d = deps({ env: { PATH: '/bin' }, files: ['/usr/bin/python3'] });
	assert.equal(resolvePythonBin(d), '/usr/bin/python3');
});

const winBase = {
	platform: 'win32' as const,
	env: { PATH: 'C:\\Users\\Alp\\AppData\\Local\\Microsoft\\WindowsApps;C:\\Py' },
	home: 'C:\\Users\\Alp',
	dataDir: 'C:\\data'
};

test('windows: PATH scan skips WindowsApps', () => {
	const d = deps({ ...winBase, files: ['C:\\Users\\Alp\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe', 'C:\\Py\\python.exe'] });
	assert.equal(resolvePythonBin(d), 'C:\\Py\\python.exe');
});

test('windows: venv Scripts python preferred over PATH', () => {
	const d = deps({ ...winBase, files: ['C:\\data\\python-venv\\Scripts\\python.exe', 'C:\\Py\\python.exe'] });
	assert.equal(resolvePythonBin(d), 'C:\\data\\python-venv\\Scripts\\python.exe');
});

test('windows: Programs\\Python numeric sort and last-resort fallback', () => {
	const prog = 'C:\\Users\\Alp\\AppData\\Local\\Programs\\Python';
	const d = deps({
		...winBase,
		env: { PATH: '' },
		files: [prog, `${prog}\\Python312\\python.exe`, `${prog}\\Python39\\python.exe`],
		dirs: { [prog]: ['Python39', 'Python312'] }
	});
	assert.equal(resolvePythonBin(d), `${prog}\\Python312\\python.exe`);
	assert.equal(resolvePythonBin(deps({ ...winBase, env: { PATH: '' } })), 'python');
});

test('windows: PYTHON_BIN still first', () => {
	const d = deps({ ...winBase, env: { PYTHON_BIN: 'D:\\py.exe' }, files: ['C:\\data\\python-venv\\Scripts\\python.exe'] });
	assert.equal(resolvePythonBin(d), 'D:\\py.exe');
});

test('venvPythonPath per platform', () => {
	assert.equal(venvPythonPath('/data', 'linux'), '/data/python-venv/bin/python3');
	assert.equal(venvPythonPath('C:\\d', 'win32'), 'C:\\d\\python-venv\\Scripts\\python.exe');
});

test('parsePythonVersion', () => {
	assert.deepEqual(parsePythonVersion('Python 3.9.6'), { major: 3, minor: 9, patch: 6 });
	assert.deepEqual(parsePythonVersion('Python 3.12.0rc2\n'), { major: 3, minor: 12, patch: 0 });
	assert.equal(parsePythonVersion('garbage'), null);
});

test('isPythonVersionSupported: >= 3.10', () => {
	assert.equal(isPythonVersionSupported({ major: 3, minor: 9, patch: 6 }), false);
	assert.equal(isPythonVersionSupported({ major: 3, minor: 10, patch: 0 }), true);
	assert.equal(isPythonVersionSupported({ major: 3, minor: 12, patch: 0 }), true);
	assert.equal(isPythonVersionSupported({ major: 2, minor: 7, patch: 18 }), false);
});

test('venv/pip command construction', () => {
	assert.deepEqual(venvCreateCommand('/usr/bin/python3', '/data/python-venv'), {
		bin: '/usr/bin/python3',
		args: ['-m', 'venv', '/data/python-venv']
	});
	assert.deepEqual(pipInstallCommand('/data/python-venv/bin/python3', '/app/ingest/requirements.txt'), {
		bin: '/data/python-venv/bin/python3',
		args: ['-m', 'pip', 'install', '-r', '/app/ingest/requirements.txt']
	});
});

test('isVenvModuleMissing recognises Debian hints', () => {
	assert.equal(isVenvModuleMissing('The virtual environment was not created successfully because ensurepip is not available.'), true);
	assert.equal(isVenvModuleMissing('apt install python3.11-venv'), true);
	assert.equal(isVenvModuleMissing('Permission denied'), false);
});

test('pickSupportedPython prefers a supported interpreter over an older earlier one', async () => {
	const mk = (minor: number): PythonVersionCheck => ({
		ok: true,
		version: { major: 3, minor, patch: 0 },
		raw: `Python 3.${minor}.0`,
		supported: minor >= 10
	});
	const table: Record<string, PythonVersionCheck> = { '/a': mk(9), '/b': mk(12) };
	const r = await pickSupportedPython(['/a', '/b'], async (b) => table[b]);
	assert.equal(r?.bin, '/b');
	const r2 = await pickSupportedPython(['/a'], async (b) => table[b]);
	assert.equal(r2?.bin, '/a');
	assert.equal(await pickSupportedPython([], async (b) => table[b]), null);
});

// --- Windows: bundled Python + the "docling is never shadowed" invariant (TODO #53) ---
const BUNDLED = 'C:\\App\\_up_\\dist-server\\python\\python.exe';
const VENV = 'C:\\data\\python-venv\\Scripts\\python.exe';
const SYS = 'C:\\Py\\python.exe';
const DOCLING_SYS = 'C:\\Py\\Lib\\site-packages\\docling';
const DOCLING_VENV = 'C:\\data\\python-venv\\Lib\\site-packages\\docling';
const win = (files: string[], over: Partial<PythonResolveDeps> & { dirs?: Record<string, string[]> } = {}) =>
	deps({ ...winBase, env: { PATH: 'C:\\Py' }, bundledPython: BUNDLED, files, ...over });

test('windows: bundledPythonPath sits at <server root>\\python\\python.exe', () => {
	assert.equal(bundledPythonPath('C:\\App\\_up_\\dist-server'), BUNDLED);
});

test('windows: bundled Python is used when nothing else exists, and beats a docling-less system Python', () => {
	assert.equal(resolvePythonBin(win([BUNDLED])), BUNDLED);
	assert.equal(resolvePythonBin(win([BUNDLED, SYS])), BUNDLED);
});

test('windows: a bundledPython path that is not on disk is ignored (dev run / older layout)', () => {
	assert.equal(resolvePythonBin(win([SYS])), SYS);
	assert.equal(resolvePythonBin(win([])), 'python');
});

test('windows: a system Python with docling is never shadowed by bundled or a docling-less venv', () => {
	assert.equal(resolvePythonBin(win([BUNDLED, SYS, DOCLING_SYS])), SYS);
	assert.equal(resolvePythonBin(win([BUNDLED, SYS, DOCLING_SYS, VENV])), SYS);
});

test('windows: docling is also found in the per-user site-packages', () => {
	const user = 'C:\\Users\\Alp\\AppData\\Roaming\\Python';
	const d = win([BUNDLED, SYS, user, `${user}\\Python312\\site-packages\\docling`], {
		env: { PATH: 'C:\\Py', APPDATA: 'C:\\Users\\Alp\\AppData\\Roaming' },
		dirs: { [user]: ['Python312'] }
	});
	assert.equal(resolvePythonBin(d), SYS);
});

test('windows: the app venv with docling beats a system Python with docling; without docling it loses to one', () => {
	assert.equal(resolvePythonBin(win([VENV, DOCLING_VENV, SYS, DOCLING_SYS, BUNDLED])), VENV);
	assert.equal(resolvePythonBin(win([VENV, SYS, DOCLING_SYS, BUNDLED])), SYS);
});

test('windows: the docling-less app venv (created from the bundled Python) beats bundled and system', () => {
	assert.equal(resolvePythonBin(win([VENV, BUNDLED, SYS])), VENV);
});

test('windows: PYTHON_BIN still wins over a docling Python', () => {
	assert.equal(resolvePythonBin(win([SYS, DOCLING_SYS, BUNDLED], { env: { PYTHON_BIN: 'D:\\py.exe', PATH: 'C:\\Py' } })), 'D:\\py.exe');
});

test('pythonHasDocling: venv layout, never off Windows', () => {
	assert.equal(pythonHasDocling(win([DOCLING_VENV]), VENV), true);
	assert.equal(pythonHasDocling(win([]), VENV), false);
	assert.equal(pythonHasDocling(deps({ files: ['/usr/lib/docling'] }), '/usr/bin/python3'), false);
});

test('posix: unchanged order (venv, then PATH), no docling logic', () => {
	const d = deps({ files: ['/data/python-venv/bin/python3', '/usr/bin/python3'], bundledPython: '/nope' });
	assert.equal(resolvePythonBin(d), '/data/python-venv/bin/python3');
});
