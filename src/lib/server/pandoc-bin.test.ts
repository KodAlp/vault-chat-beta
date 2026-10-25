import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { resolvePandocBin } from './pandoc-bin';

const WIN32_DIRS = ['C:\\Windows\\system32', 'C:\\Users\\user\\AppData\\Local\\Microsoft\\WindowsApps'];

function winEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	return {
		PATH: WIN32_DIRS.join(';'),
		LOCALAPPDATA: 'C:\\Users\\user\\AppData\\Local',
		ProgramFiles: 'C:\\Program Files',
		...overrides
	};
}

test('honours PANDOC_BIN when it points at a real file', () => {
	const exists = (p: string) => p === 'D:\\custom\\pandoc.exe';
	const bin = resolvePandocBin(winEnv({ PANDOC_BIN: 'D:\\custom\\pandoc.exe' }), exists, 'win32');
	assert.equal(bin, 'D:\\custom\\pandoc.exe');
});

test('ignores a stale PANDOC_BIN that does not exist and keeps searching', () => {
	const exists = (p: string) => p === path.win32.join('C:\\Windows\\system32', 'pandoc.exe');
	const bin = resolvePandocBin(winEnv({ PANDOC_BIN: 'D:\\gone\\pandoc.exe' }), exists, 'win32');
	assert.equal(bin, path.win32.join('C:\\Windows\\system32', 'pandoc.exe'));
});

test('finds pandoc.exe on PATH', () => {
	const exists = (p: string) => p === path.win32.join('C:\\Windows\\system32', 'pandoc.exe');
	const bin = resolvePandocBin(winEnv(), exists, 'win32');
	assert.equal(bin, path.win32.join('C:\\Windows\\system32', 'pandoc.exe'));
});

test('skips a WindowsApps PATH entry rather than matching a redirector shim there', () => {
	const exists = (p: string) => p.toLowerCase().includes('windowsapps');
	const bin = resolvePandocBin(winEnv(), exists, 'win32');
	assert.equal(bin, null);
});

test('falls back to the winget default install location (%LOCALAPPDATA%\\Pandoc) when PATH has nothing', () => {
	const expected = path.win32.join('C:\\Users\\user\\AppData\\Local', 'Pandoc', 'pandoc.exe');
	const exists = (p: string) => p === expected;
	const bin = resolvePandocBin(winEnv(), exists, 'win32');
	assert.equal(bin, expected);
});

test('falls back to %ProgramFiles%\\Pandoc when neither PATH nor %LOCALAPPDATA% has it', () => {
	const expected = path.win32.join('C:\\Program Files', 'Pandoc', 'pandoc.exe');
	const exists = (p: string) => p === expected;
	const bin = resolvePandocBin(winEnv(), exists, 'win32');
	assert.equal(bin, expected);
});

test('returns null on Windows when nothing matches anywhere', () => {
	const bin = resolvePandocBin(winEnv(), () => false, 'win32');
	assert.equal(bin, null);
});

test('non-Windows: returns the absolute path when found on PATH', () => {
	const exists = (p: string) => p === '/usr/bin/pandoc';
	const bin = resolvePandocBin({ PATH: '/usr/bin:/bin' }, exists, 'linux');
	assert.equal(bin, '/usr/bin/pandoc');
});

test('non-Windows: falls back to Homebrew (Apple Silicon) when PATH is minimal', () => {
	const exists = (p: string) => p === '/opt/homebrew/bin/pandoc';
	const bin = resolvePandocBin({ PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }, exists, 'darwin');
	assert.equal(bin, '/opt/homebrew/bin/pandoc');
});

test('non-Windows: falls back to /usr/local/bin, preferred over /usr/bin', () => {
	const exists = (p: string) => p === '/usr/local/bin/pandoc' || p === '/usr/bin/pandoc';
	const bin = resolvePandocBin({ PATH: '/bin' }, exists, 'darwin');
	assert.equal(bin, '/usr/local/bin/pandoc');
});

test('non-Windows: falls back to /usr/bin/pandoc with an empty PATH', () => {
	const exists = (p: string) => p === '/usr/bin/pandoc';
	const bin = resolvePandocBin({}, exists, 'linux');
	assert.equal(bin, '/usr/bin/pandoc');
});

test('non-Windows: PATH hit wins over known locations', () => {
	const exists = () => true;
	const bin = resolvePandocBin({ PATH: '/custom/bin' }, exists, 'linux');
	assert.equal(bin, '/custom/bin/pandoc');
});

test('non-Windows: returns null when not found on PATH', () => {
	const bin = resolvePandocBin({ PATH: '/usr/bin:/bin' }, () => false, 'linux');
	assert.equal(bin, null);
});

test('non-Windows still honours a valid PANDOC_BIN override', () => {
	const exists = (p: string) => p === '/opt/pandoc/bin/pandoc';
	const bin = resolvePandocBin({ PANDOC_BIN: '/opt/pandoc/bin/pandoc', PATH: '/usr/bin' }, exists, 'linux');
	assert.equal(bin, '/opt/pandoc/bin/pandoc');
});
