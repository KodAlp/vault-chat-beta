import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyNoteEdit, splitFrontmatter } from './mcp-edit-note';
import { sha256, writeLibraryFile, type Indexer } from './library-write';
import { readMcpSettings, writeMcpSettings } from './mcp-settings';
import { AppError } from './app-error';
import type { VaultContext } from './vaults';

const code = (c: string) => (e: unknown) => e instanceof AppError && e.code === c;

const NOTE = '---\nsource: a.pdf\nconverter: docling\n---\n# Title\n\nalpha beta\nbeta gamma\n';
const HASH = sha256(NOTE);

test('exact replacement edits the body and keeps the frontmatter byte for byte', () => {
	const next = applyNoteEdit(NOTE, HASH, { oldString: 'alpha', newString: 'ALPHA' });
	assert.equal(next, NOTE.replace('alpha', 'ALPHA'));
	assert.equal(splitFrontmatter(next).head, splitFrontmatter(NOTE).head);
});

test('content replaces the body only; frontmatter is re-attached', () => {
	const next = applyNoteEdit(NOTE, HASH, { content: 'new body\n' });
	assert.equal(next, '---\nsource: a.pdf\nconverter: docling\n---\nnew body\n');
});

test('a stale hash is rejected as LIBRARY_EDIT_CONFLICT', () => {
	assert.throws(() => applyNoteEdit(NOTE, sha256('other'), { content: 'x' }), code('LIBRARY_EDIT_CONFLICT'));
});

test('old_string that is missing, not unique or empty is rejected', () => {
	assert.throws(() => applyNoteEdit(NOTE, HASH, { oldString: 'zzz', newString: 'x' }), code('MCP_EDIT_NOT_FOUND'));
	assert.throws(() => applyNoteEdit(NOTE, HASH, { oldString: 'beta', newString: 'x' }), code('MCP_EDIT_NOT_UNIQUE'));
	assert.throws(() => applyNoteEdit(NOTE, HASH, { oldString: '', newString: 'x' }), code('VALIDATION_INVALID'));
});

test('old_string cannot reach into the frontmatter', () => {
	assert.throws(() => applyNoteEdit(NOTE, HASH, { oldString: 'converter: docling', newString: 'converter: evil' }), code('MCP_EDIT_NOT_FOUND'));
});

test('a body that smuggles in or closes a frontmatter block is rejected', () => {
	// A second `---` block after the real one is just body text: the parsed frontmatter stays the original.
	const dup = applyNoteEdit(NOTE, HASH, { content: '---\nconverter: evil\n---\nbody' });
	assert.equal(splitFrontmatter(dup).head, splitFrontmatter(NOTE).head);
	const bare = 'plain note\n';
	assert.throws(() => applyNoteEdit(bare, sha256(bare), { content: '---\nneeds_review: false\n---\nx' }), code('VALIDATION_INVALID'));
	const mid = 'plain\n---\nx\n';
	assert.throws(() => applyNoteEdit(mid, sha256(mid), { oldString: 'plain', newString: '---\nk: v' }), code('VALIDATION_INVALID'));
});

test('a note without frontmatter can be edited', () => {
	assert.equal(applyNoteEdit('hello world', sha256('hello world'), { oldString: 'world', newString: 'there' }), 'hello there');
});

function tmpVault(): VaultContext {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-edit-note-test-'));
	const libraryRoot = path.join(dir, 'library');
	fs.mkdirSync(path.join(libraryRoot, '_meta'), { recursive: true });
	return { id: 't', name: 'T', dir, libraryRoot, indexDbPath: path.join(dir, 'index.db'), studyDbPath: path.join(dir, 'study.db') };
}
const noIndex: Indexer = async () => {};

test('the write door the route uses rejects traversal, non-.md files, _meta and missing files', async () => {
	const v = tmpVault();
	fs.writeFileSync(path.join(v.libraryRoot, 'a.md'), NOTE);
	fs.writeFileSync(path.join(v.libraryRoot, 'a.txt'), 'x');
	fs.writeFileSync(path.join(path.dirname(v.libraryRoot), 'outside.md'), 'x');
	fs.writeFileSync(path.join(v.libraryRoot, '_meta', 'settings.md'), 'x');
	const h = sha256('x');
	await assert.rejects(writeLibraryFile(v, '../outside.md', 'y', h, { by: 'mcp', indexer: noIndex }), code('PATH_OUTSIDE_LIBRARY'));
	await assert.rejects(writeLibraryFile(v, 'a.txt', 'y', h, { by: 'mcp', indexer: noIndex }), code('LIBRARY_EDIT_FORBIDDEN'));
	await assert.rejects(writeLibraryFile(v, '_meta/settings.md', 'y', h, { by: 'mcp', indexer: noIndex }), code('LIBRARY_EDIT_FORBIDDEN'));
	await assert.rejects(writeLibraryFile(v, 'missing.md', 'y', h, { by: 'mcp', indexer: noIndex }), code('LIBRARY_EDIT_FORBIDDEN'));
	// and the happy path logs the edit as made by mcp
	const next = applyNoteEdit(NOTE, HASH, { oldString: 'alpha', newString: 'ALPHA' });
	await writeLibraryFile(v, 'a.md', next, HASH, { by: 'mcp', indexer: noIndex });
	assert.equal(fs.readFileSync(path.join(v.libraryRoot, 'a.md'), 'utf-8'), next);
	const log = fs.readFileSync(path.join(v.libraryRoot, '_meta', 'edit-log.jsonl'), 'utf-8');
	assert.equal(JSON.parse(log.trim().split('\n').pop() as string).by, 'mcp');
});

test('allowEditNote is off by default, strict boolean, and survives unrelated writes', () => {
	process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-edit-setting-'));
	assert.equal(readMcpSettings().allowEditNote, false);
	fs.writeFileSync(path.join(process.env.DATA_DIR, 'mcp-settings.json'), JSON.stringify({ allowEditNote: 'true' }));
	assert.equal(readMcpSettings().allowEditNote, false);
	assert.throws(() => writeMcpSettings({ allowEditNote: 'yes' }), code('VALIDATION_INVALID'));
	assert.equal(writeMcpSettings({ allowEditNote: true }).allowEditNote, true);
	assert.equal(writeMcpSettings({ allowedImportRoots: [] }).allowEditNote, true);
	assert.equal(writeMcpSettings({ allowEditNote: false }).allowEditNote, false);
});
