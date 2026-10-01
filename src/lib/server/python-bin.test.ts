import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	resolvePythonBin,
	parsePythonVersion,
	isPythonVersionSupported,
	venvPythonPath,
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
