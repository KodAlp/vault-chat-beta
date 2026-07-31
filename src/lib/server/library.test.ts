import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renameLibraryEntry } from './library';
import type { VaultContext } from './vaults';

function tmpVault(): VaultContext {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'library-test-'));
	const libraryRoot = path.join(dir, 'library');
	fs.mkdirSync(libraryRoot, { recursive: true });
	return {
		id: 'test',
		name: 'Test',
		dir,
		libraryRoot,
		indexDbPath: path.join(dir, 'index.db'),
		studyDbPath: path.join(dir, 'study.db')
	};
}

test('renameLibraryEntry moves a file to a free target path', () => {
	const v = tmpVault();
	fs.writeFileSync(path.join(v.libraryRoot, 'a.md'), 'hello');

	renameLibraryEntry(v, 'a.md', 'b.md');

	assert.equal(fs.existsSync(path.join(v.libraryRoot, 'a.md')), false);
	assert.equal(fs.readFileSync(path.join(v.libraryRoot, 'b.md'), 'utf-8'), 'hello');
});

test('renameLibraryEntry refuses to overwrite an existing target', () => {
	const v = tmpVault();
	fs.writeFileSync(path.join(v.libraryRoot, 'a.md'), 'source');
	fs.writeFileSync(path.join(v.libraryRoot, 'b.md'), 'already here');

	assert.throws(() => renameLibraryEntry(v, 'a.md', 'b.md'), /zaten var/);

	// Neither file should have moved — both must survive untouched.
	assert.equal(fs.readFileSync(path.join(v.libraryRoot, 'a.md'), 'utf-8'), 'source');
	assert.equal(fs.readFileSync(path.join(v.libraryRoot, 'b.md'), 'utf-8'), 'already here');
});

test('renameLibraryEntry refuses a directory source', () => {
	const v = tmpVault();
	fs.mkdirSync(path.join(v.libraryRoot, 'folder'));

	assert.throws(() => renameLibraryEntry(v, 'folder', 'renamed'), /klasörler değil/);
});
