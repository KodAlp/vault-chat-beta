import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveLibraryPath, getLibraryTree, readLibraryFile, getLibrarySettings } from './library-read';
import type { VaultContext } from './vaults';

function tmpVault(): VaultContext {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'library-read-test-'));
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

test('resolveLibraryPath accepts a plain nested-but-legal relative path', () => {
	const v = tmpVault();
	const resolved = resolveLibraryPath(v, 'math/calculus.md');
	assert.equal(resolved, path.join(v.libraryRoot, 'math', 'calculus.md'));
});

test('resolveLibraryPath rejects a unix-style parent escape', () => {
	const v = tmpVault();
	assert.throws(() => resolveLibraryPath(v, '../outside.md'));
});

test('resolveLibraryPath rejects a deeper unix-style parent escape', () => {
	const v = tmpVault();
	assert.throws(() => resolveLibraryPath(v, 'math/../../outside.md'));
});

test('resolveLibraryPath rejects a Windows-style backslash parent escape', { skip: process.platform !== 'win32' ? 'backslash is a literal filename character, not a separator, on POSIX' : false }, () => {
	const v = tmpVault();
	assert.throws(() => resolveLibraryPath(v, '..\\outside.md'));
});

test('resolveLibraryPath rejects an absolute path outside the root', () => {
	const v = tmpVault();
	const outside = path.join(os.tmpdir(), 'definitely-outside.md');
	assert.throws(() => resolveLibraryPath(v, outside));
});

test('resolveLibraryPath rejects a sibling directory whose name merely starts with the root name', () => {
	const v = tmpVault();
	// e.g. root is ".../library", this targets ".../library-evil/x.md" —
	// a naive prefix check without the separator guard would let this through.
	const sibling = `${v.libraryRoot}-evil`;
	fs.mkdirSync(sibling, { recursive: true });
	assert.throws(() => resolveLibraryPath(v, path.join('..', path.basename(sibling), 'x.md')));
});

test('resolveLibraryPath does not create the library root as a side effect', () => {
	const v = tmpVault();
	fs.rmSync(v.libraryRoot, { recursive: true, force: true });
	assert.equal(fs.existsSync(v.libraryRoot), false);
	resolveLibraryPath(v, 'note.md');
	assert.equal(fs.existsSync(v.libraryRoot), false);
});

test('getLibraryTree returns an empty array for a library root that does not exist yet', () => {
	const v = tmpVault();
	fs.rmSync(v.libraryRoot, { recursive: true, force: true });
	assert.deepEqual(getLibraryTree(v), []);
	assert.equal(fs.existsSync(v.libraryRoot), false);
});

test('getLibraryTree lists files and nested folders, skipping _meta and dotfiles', () => {
	const v = tmpVault();
	fs.mkdirSync(path.join(v.libraryRoot, 'math'), { recursive: true });
	fs.mkdirSync(path.join(v.libraryRoot, '_meta'), { recursive: true });
	fs.writeFileSync(path.join(v.libraryRoot, 'notes.md'), '# Notes');
	fs.writeFileSync(path.join(v.libraryRoot, 'math', 'calc.md'), '# Calc');
	fs.writeFileSync(path.join(v.libraryRoot, '_meta', 'settings.json'), '{}');
	fs.writeFileSync(path.join(v.libraryRoot, '.hidden.md'), '# Hidden');

	const tree = getLibraryTree(v);
	const names = tree.map((n) => n.name).sort();
	assert.deepEqual(names, ['math', 'notes.md']);

	const mathNode = tree.find((n) => n.name === 'math');
	assert.equal(mathNode?.type, 'folder');
	assert.equal(mathNode?.children?.[0].name, 'calc.md');
});

test('readLibraryFile returns the raw file content including frontmatter', () => {
	const v = tmpVault();
	const content = '---\ntitle: X\n---\n\nBody text';
	fs.writeFileSync(path.join(v.libraryRoot, 'note.md'), content);
	assert.equal(readLibraryFile(v, 'note.md'), content);
});

test('readLibraryFile rejects a traversal attempt instead of reading the file', () => {
	const v = tmpVault();
	assert.throws(() => readLibraryFile(v, '../../../../etc/passwd'));
});

test('getLibrarySettings returns defaults (fail-open) when no settings.json exists', () => {
	const v = tmpVault();
	const settings = getLibrarySettings(v);
	assert.deepEqual(settings.hiddenFolders, ['raw', 'cards', 'frontier', 'notes', 'wiki/_index']);
	assert.deepEqual(settings.flattenFolders, ['wiki']);
	assert.deepEqual(settings.allowedLanguages, ['Türkçe']);
	assert.equal(settings.responseLanguage, 'match');
});

test('getLibrarySettings defaults responseLanguage to "match" for a pre-existing settings.json that predates the field', () => {
	const v = tmpVault();
	fs.mkdirSync(path.join(v.libraryRoot, '_meta'), { recursive: true });
	fs.writeFileSync(
		path.join(v.libraryRoot, '_meta', 'settings.json'),
		JSON.stringify({ keepOriginals: true, allowedLanguages: ['Türkçe'], hiddenFolders: [], flattenFolders: [] })
	);
	const settings = getLibrarySettings(v);
	assert.equal(settings.responseLanguage, 'match');
	assert.equal(settings.keepOriginals, true);
});

test('getLibrarySettings merges a partial saved file over the defaults', () => {
	const v = tmpVault();
	fs.mkdirSync(path.join(v.libraryRoot, '_meta'), { recursive: true });
	fs.writeFileSync(
		path.join(v.libraryRoot, '_meta', 'settings.json'),
		JSON.stringify({ hiddenFolders: ['raw'] })
	);
	const settings = getLibrarySettings(v);
	assert.deepEqual(settings.hiddenFolders, ['raw']); // overridden
	assert.deepEqual(settings.flattenFolders, ['wiki']); // still the default
});
