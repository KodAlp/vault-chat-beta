import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanFolder, validateScanRoot, resolveScannedFile } from './folder-scan';
import { createScanRegistry } from './scan-registry';
import { AppError } from './app-error';

function isCode(code: string) {
	return (err: unknown) => err instanceof AppError && err.code === code;
}

function tmp(prefix: string): string {
	return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function makeTree(): { root: string; outside: string } {
	const base = tmp('scan-test-');
	const root = path.join(base, 'Picked');
	const outside = path.join(base, 'outside');
	fs.mkdirSync(path.join(root, 'sub', 'deep'), { recursive: true });
	fs.mkdirSync(path.join(root, '.git'), { recursive: true });
	fs.mkdirSync(path.join(root, '__MACOSX'), { recursive: true });
	fs.mkdirSync(outside, { recursive: true });
	fs.writeFileSync(path.join(root, 'a.pdf'), 'x');
	fs.writeFileSync(path.join(root, 'notes.exe'), 'x');
	fs.writeFileSync(path.join(root, '.hidden.pdf'), 'x');
	fs.writeFileSync(path.join(root, 'sub', 'b.md'), 'x');
	fs.writeFileSync(path.join(root, 'sub', 'deep', 'c.docx'), 'x');
	fs.writeFileSync(path.join(root, '.git', 'config.json'), 'x');
	fs.writeFileSync(path.join(root, '__MACOSX', 'z.pdf'), 'x');
	fs.writeFileSync(path.join(outside, 'secret.pdf'), 'secret');
	return { root, outside };
}

function trySymlink(target: string, link: string, type: 'file' | 'dir'): boolean {
	try {
		fs.symlinkSync(target, link, type === 'dir' ? 'junction' : 'file');
		return true;
	} catch {
		return false; // no symlink privilege (Windows without developer mode)
	}
}

test('scan lists files, flags unsupported ones, prunes junk directories', () => {
	const { root } = makeTree();
	const res = scanFolder(validateScanRoot(root, []));
	assert.equal(res.folderName, 'Picked');
	const byPath = new Map(res.entries.map((e) => [e.relPath, e]));
	assert.equal(byPath.get('a.pdf')?.skip, undefined);
	assert.equal(byPath.get('sub/b.md')?.skip, undefined);
	assert.equal(byPath.get('sub/deep/c.docx')?.skip, undefined);
	assert.equal(byPath.get('notes.exe')?.skip, 'unsupported');
	assert.equal(byPath.get('.hidden.pdf')?.skip, 'junk');
	assert.ok(![...byPath.keys()].some((k) => k.startsWith('.git/') || k.startsWith('__MACOSX/')));
});

test('symlinks are never listed, files or directories', () => {
	const { root, outside } = makeTree();
	const a = trySymlink(path.join(outside, 'secret.pdf'), path.join(root, 'link.pdf'), 'file');
	const b = trySymlink(outside, path.join(root, 'linkdir'), 'dir');
	const res = scanFolder(validateScanRoot(root, []));
	const paths = res.entries.map((e) => e.relPath);
	if (a) assert.ok(!paths.includes('link.pdf'));
	if (b) assert.ok(!paths.some((p) => p.startsWith('linkdir/')));
	assert.ok(!paths.some((p) => p.includes('secret')));
});

test('protected directories are pruned from a scan', () => {
	const { root } = makeTree();
	const real = validateScanRoot(root, []);
	const res = scanFolder(real, [path.join(real, 'sub')]);
	assert.ok(!res.entries.some((e) => e.relPath.startsWith('sub/')));
	assert.ok(res.entries.some((e) => e.relPath === 'a.pdf'));
});

test('validateScanRoot rejects bad roots', () => {
	const { root } = makeTree();
	for (const bad of [undefined, null, 42, '', 'relative/dir', './x', 'a\0b', path.join(root, 'nope')]) {
		assert.throws(() => validateScanRoot(bad, []), isCode('SCAN_ROOT_INVALID'));
	}
	// a file, not a directory
	assert.throws(() => validateScanRoot(path.join(root, 'a.pdf'), []), isCode('SCAN_ROOT_INVALID'));
	// the filesystem root
	assert.throws(() => validateScanRoot(path.parse(root).root, []), isCode('SCAN_ROOT_INVALID'));
});

test('validateScanRoot refuses protected dirs and anything inside them', () => {
	const { root } = makeTree();
	assert.throws(() => validateScanRoot(root, [root]), isCode('SCAN_ROOT_INVALID'));
	assert.throws(() => validateScanRoot(path.join(root, 'sub'), [root]), isCode('SCAN_ROOT_INVALID'));
	// an ancestor of a protected dir is allowed (the protected dir is pruned instead)
	assert.doesNotThrow(() => validateScanRoot(path.dirname(root), [root]));
});

test('resolveScannedFile accepts a listed file', () => {
	const { root } = makeTree();
	const real = validateScanRoot(root, []);
	const r = resolveScannedFile(real, 'sub/b.md');
	assert.equal(r.abs, path.join(real, 'sub', 'b.md'));
	assert.equal(r.size, 1);
	assert.equal(resolveScannedFile(real, 'sub\\b.md').abs, path.join(real, 'sub', 'b.md'));
});

test('resolveScannedFile rejects traversal, absolute and malformed paths', () => {
	const { root } = makeTree();
	const real = validateScanRoot(root, []);
	const bad: unknown[] = [
		'../outside/secret.pdf',
		'sub/../../outside/secret.pdf',
		'..\\outside\\secret.pdf',
		'/etc/passwd',
		'\\windows\\x.pdf',
		'C:\\x.pdf',
		'C:x.pdf',
		path.join(path.dirname(root), 'outside', 'secret.pdf'),
		'',
		'.',
		'sub//b.md',
		'sub/./b.md',
		'sub/',
		'a.pdf\0.png',
		undefined,
		null,
		7
	];
	for (const rel of bad) assert.throws(() => resolveScannedFile(real, rel), isCode('SCAN_PATH_INVALID'), String(rel));
	// a directory is not a file
	assert.throws(() => resolveScannedFile(real, 'sub'), isCode('SCAN_PATH_INVALID'));
	// a missing file
	assert.throws(() => resolveScannedFile(real, 'nope.pdf'), isCode('SCAN_PATH_INVALID'));
});

test('resolveScannedFile re-applies extension and junk rules', () => {
	const { root } = makeTree();
	const real = validateScanRoot(root, []);
	assert.throws(() => resolveScannedFile(real, 'notes.exe'), isCode('UNSUPPORTED_FILE_TYPE'));
	assert.throws(() => resolveScannedFile(real, '.hidden.pdf'), isCode('SCAN_PATH_INVALID'));
	assert.throws(() => resolveScannedFile(real, '.git/config.json'), isCode('SCAN_PATH_INVALID'));
});

test('resolveScannedFile never follows a symlink out of the root', () => {
	const { root, outside } = makeTree();
	const real = validateScanRoot(root, []);
	if (trySymlink(path.join(outside, 'secret.pdf'), path.join(root, 'link.pdf'), 'file')) {
		assert.throws(() => resolveScannedFile(real, 'link.pdf'), isCode('SCAN_PATH_INVALID'));
	}
	if (trySymlink(outside, path.join(root, 'linkdir'), 'dir')) {
		assert.throws(() => resolveScannedFile(real, 'linkdir/secret.pdf'), isCode('SCAN_PATH_INVALID'));
	}
});

test('scan registry: ttl, cap, vault binding, bad ids', () => {
	let t = 1000;
	let n = 0;
	const reg = createScanRegistry({ ttlMs: 100, maxScans: 2, now: () => t, newId: () => `id${++n}` });
	const a = reg.add('v1', '/r', ['x.pdf']);
	assert.equal(reg.get(a, 'v1')?.root, '/r');
	assert.ok(reg.get(a, 'v1')?.allowed.has('x.pdf'));
	assert.equal(reg.get(a, 'other-vault'), undefined);
	assert.equal(reg.get(undefined, 'v1'), undefined);
	assert.equal(reg.get({}, 'v1'), undefined);
	assert.equal(reg.get('nope', 'v1'), undefined);
	// cap: the oldest is dropped
	const b = reg.add('v1', '/r2', []);
	const c = reg.add('v1', '/r3', []);
	assert.equal(reg.get(a, 'v1'), undefined);
	assert.ok(reg.get(b, 'v1'));
	assert.ok(reg.get(c, 'v1'));
	assert.ok(reg.size() <= 2);
	// ttl
	t += 100;
	assert.equal(reg.get(b, 'v1'), undefined);
	assert.equal(reg.size(), 0);
});
