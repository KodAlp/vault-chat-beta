import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readMcpSettings, writeMcpSettings, sanitizeImportRoots, isInsideAllowedRoots, MAX_ALLOWED_IMPORT_ROOTS } from './mcp-settings';
import { AppError } from './app-error';

function tmp(prefix = 'mcp-settings-test-'): string {
	return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function useTmpDataDir(): string {
	const dir = tmp();
	process.env.DATA_DIR = dir;
	return dir;
}

test('a fresh DATA_DIR has no allowed roots', () => {
	useTmpDataDir();
	assert.deepEqual(readMcpSettings(), { allowedImportRoots: [] });
});

test('write stores the realpath, dedupes, and reads back', () => {
	useTmpDataDir();
	const root = tmp();
	const out = writeMcpSettings({ allowedImportRoots: [root, root, root + path.sep] });
	assert.deepEqual(out, { allowedImportRoots: [root] });
	assert.deepEqual(readMcpSettings(), { allowedImportRoots: [root] });
});

test('dedupe ignores letter case on Windows', { skip: process.platform !== 'win32' }, () => {
	const root = tmp();
	assert.deepEqual(sanitizeImportRoots([root, root.toUpperCase()]), [root]);
});

test('relative, missing, non-directory, non-string and root entries are rejected', () => {
	useTmpDataDir();
	const dir = tmp();
	const file = path.join(dir, 'a.txt');
	fs.writeFileSync(file, 'x');
	for (const bad of [['relative/dir'], [path.join(dir, 'missing')], [file], [42], [''], [path.parse(dir).root]]) {
		assert.throws(() => sanitizeImportRoots(bad), (e) => e instanceof AppError && e.code === 'VALIDATION_INVALID', JSON.stringify(bad));
	}
	assert.throws(() => sanitizeImportRoots('nope'), AppError);
});

test('more than the maximum number of roots is rejected', () => {
	useTmpDataDir();
	const parent = tmp();
	const roots = Array.from({ length: MAX_ALLOWED_IMPORT_ROOTS + 1 }, (_, i) => {
		const d = path.join(parent, `r${i}`);
		fs.mkdirSync(d);
		return d;
	});
	assert.equal(sanitizeImportRoots(roots.slice(0, MAX_ALLOWED_IMPORT_ROOTS)).length, MAX_ALLOWED_IMPORT_ROOTS);
	assert.throws(() => sanitizeImportRoots(roots), AppError);
});

test('a corrupt file reads as the default', () => {
	const dir = useTmpDataDir();
	fs.writeFileSync(path.join(dir, 'mcp-settings.json'), '{oops');
	assert.deepEqual(readMcpSettings(), { allowedImportRoots: [] });
});

test('isInsideAllowedRoots honours path-segment boundaries', () => {
	const parent = tmp();
	const b = path.join(parent, 'b');
	const bc = path.join(parent, 'bc');
	fs.mkdirSync(b);
	fs.mkdirSync(bc);
	const inB = path.join(b, 'file.pdf');
	const inBc = path.join(bc, 'file.pdf');
	fs.writeFileSync(inB, 'x');
	fs.writeFileSync(inBc, 'x');
	assert.equal(isInsideAllowedRoots(inB, [b]), true);
	assert.equal(isInsideAllowedRoots(inBc, [b]), false, 'bc is not inside b');
	assert.equal(isInsideAllowedRoots(inB, []), false, 'empty allowlist allows nothing');
	assert.equal(isInsideAllowedRoots(inB, [path.join(parent, 'gone')]), false, 'a vanished root is skipped');
});

test('isInsideAllowedRoots is case-insensitive on Windows only', () => {
	const root = tmp();
	const file = path.join(root, 'file.pdf');
	fs.writeFileSync(file, 'x');
	assert.equal(isInsideAllowedRoots(file.toUpperCase(), [root]), process.platform === 'win32' || process.platform === 'darwin');
});
