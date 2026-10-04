import { test } from 'node:test';
import assert from 'node:assert/strict';
import { skipReasonFor, isJunkName, extOf, MAX_SCAN_DEPTH } from './import-filter';
import { MAX_UPLOAD_BYTES } from './import-extensions';

test('importable documents and code pass', () => {
	assert.equal(skipReasonFor('a.pdf', 10), null);
	assert.equal(skipReasonFor('sub/dir/Notes.DOCX', 10), null);
	assert.equal(skipReasonFor('src\\main.rs', 10), null);
});

test('junk segments skip the whole subtree', () => {
	assert.equal(skipReasonFor('.git/config.json', 1), 'junk');
	assert.equal(skipReasonFor('x/__MACOSX/a.pdf', 1), 'junk');
	assert.equal(skipReasonFor('.hidden.pdf', 1), 'junk');
	assert.equal(skipReasonFor('desktop.ini', 1), 'junk');
	assert.equal(skipReasonFor('Thumbs.db', 1), 'junk');
	assert.equal(skipReasonFor('.obsidian/a.md', 1), 'junk');
});

test('size and extension limits', () => {
	assert.equal(skipReasonFor('a.pdf', MAX_UPLOAD_BYTES + 1), 'tooLarge');
	assert.equal(skipReasonFor('a.pdf', MAX_UPLOAD_BYTES), null);
	assert.equal(skipReasonFor('a.exe', 1), 'unsupported');
	assert.equal(skipReasonFor('noext', 1), 'unsupported');
});

test('depth cap', () => {
	const ok = Array.from({ length: MAX_SCAN_DEPTH }, () => 'd').join('/') + '/a.pdf';
	const deep = Array.from({ length: MAX_SCAN_DEPTH + 1 }, () => 'd').join('/') + '/a.pdf';
	assert.equal(skipReasonFor(ok, 1), null);
	assert.equal(skipReasonFor(deep, 1), 'tooDeep');
});

test('empty path is junk; helpers', () => {
	assert.equal(skipReasonFor('', 1), 'junk');
	assert.equal(isJunkName('notes'), false);
	assert.equal(extOf('A.TeX'), '.tex');
	assert.equal(extOf('x'), '');
});
