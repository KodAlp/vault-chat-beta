import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { resolvePandocBin } from './pandoc-bin';

const WIN32_DIRS = ['C:\\Windows\\system32', 'C:\\Users\\Alp\\AppData\\Local\\Microsoft\\WindowsApps'];

function winEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	return {
		PATH: WIN32_DIRS.join(';'),
		LOCALAPPDATA: 'C:\\Users\\Alp\\AppData\\Local',
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
	const exists = (p: string) => p === path.join('C:\\Windows\\system32', 'pandoc.exe');
	const bin = resolvePandocBin(winEnv({ PANDOC_BIN: 'D:\\gone\\pandoc.exe' }), exists, 'win32');
	assert.equal(bin, path.join('C:\\Windows\\system32', 'pandoc.exe'));
});

test('finds pandoc.exe on PATH', () => {
	const exists = (p: string) => p === path.join('C:\\Windows\\system32', 'pandoc.exe');
	const bin = resolvePandocBin(winEnv(), exists, 'win32');
	assert.equal(bin, path.join('C:\\Windows\\system32', 'pandoc.exe'));
});

test('skips a WindowsApps PATH entry rather than matching a redirector shim there', () => {
	const exists = (p: string) => p.toLowerCase().includes('windowsapps');
	const bin = resolvePandocBin(winEnv(), exists, 'win32');
	assert.equal(bin, null);
});

test('falls back to the winget default install location (%LOCALAPPDATA%\\Pandoc) when PATH has nothing', () => {
	const expected = path.join('C:\\Users\\Alp\\AppData\\Local', 'Pandoc', 'pandoc.exe');
	const exists = (p: string) => p === expected;
	const bin = resolvePandocBin(winEnv(), exists, 'win32');
	assert.equal(bin, expected);
});

test('falls back to %ProgramFiles%\\Pandoc when neither PATH nor %LOCALAPPDATA% has it', () => {
	const expected = path.join('C:\\Program Files', 'Pandoc', 'pandoc.exe');
	const exists = (p: string) => p === expected;
	const bin = resolvePandocBin(winEnv(), exists, 'win32');
	assert.equal(bin, expected);
});

test('returns null on Windows when nothing matches anywhere', () => {
	const bin = resolvePandocBin(winEnv(), () => false, 'win32');
	assert.equal(bin, null);
});

test('non-Windows: returns the bare command name when found on PATH', () => {
	const exists = (p: string) => p === '/usr/bin/pandoc';
	const bin = resolvePandocBin({ PATH: '/usr/bin:/bin' }, exists, 'linux');
	assert.equal(bin, 'pandoc');
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
