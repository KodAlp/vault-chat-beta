import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { openDb, renameFileInIndex, upsertFile, type FileRow } from './db';
import { EMBED_DIMS } from '../src/lib/server/embed-config';

function tmpDbPath(): string {
	return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vc-rename-')), 'index.db');
}
const zero = () => Array.from({ length: EMBED_DIMS }, () => 0);
const file = (p: string): FileRow => ({ path: p, sha256: 'x', mtime: 1, topic: 't', depth: 'undergrad', domains_json: '[]' });
const chunk = (p: string, text: string) => ({ insert: { path: p, heading_path: 'h', display_text: text }, embedding: zero() });
const paths = (db: Database.Database, table: 'files' | 'chunks') =>
	(db.prepare(`SELECT DISTINCT path FROM ${table} ORDER BY path`).all() as { path: string }[]).map((r) => r.path);

// Regression: chunks.path references files.path with no ON UPDATE CASCADE, and
// better-sqlite3 enforces foreign keys by default, so this used to throw
// SQLITE_CONSTRAINT_FOREIGNKEY for every file that had chunks — after library.ts
// had already renamed the file on disk, leaving the index pointing at a dead path.
test('renaming an indexed file moves the file row and all of its chunks', () => {
	const db = openDb(tmpDbPath());
	upsertFile(db, file('old.md'), [chunk('old.md', 'one'), chunk('old.md', 'two')]);
	renameFileInIndex(db, 'old.md', 'sub/new.md');
	assert.deepEqual(paths(db, 'files'), ['sub/new.md']);
	assert.deepEqual(paths(db, 'chunks'), ['sub/new.md']);
	db.close();
});

test('the chunk ids survive a rename, so the embeddings stay attached', () => {
	const db = openDb(tmpDbPath());
	upsertFile(db, file('old.md'), [chunk('old.md', 'one'), chunk('old.md', 'two')]);
	const before = (db.prepare('SELECT id FROM chunks ORDER BY id').all() as { id: number }[]).map((r) => r.id);
	renameFileInIndex(db, 'old.md', 'new.md');
	const after = (db.prepare('SELECT id FROM chunks ORDER BY id').all() as { id: number }[]).map((r) => r.id);
	assert.deepEqual(after, before);
	assert.equal((db.prepare('SELECT count(*) AS c FROM vec_chunks').get() as { c: number }).c, 2);
	db.close();
});

test('foreign-key integrity holds after a rename', () => {
	const db = openDb(tmpDbPath());
	upsertFile(db, file('old.md'), [chunk('old.md', 'one')]);
	renameFileInIndex(db, 'old.md', 'new.md');
	assert.deepEqual(db.pragma('foreign_key_check'), []);
	db.close();
});

test('renaming a path that is not indexed is a harmless no-op', () => {
	const db = openDb(tmpDbPath());
	upsertFile(db, file('a.md'), [chunk('a.md', 'x')]);
	assert.doesNotThrow(() => renameFileInIndex(db, 'missing.md', 'other.md'));
	assert.deepEqual(paths(db, 'files'), ['a.md']);
	db.close();
});

test('renaming onto an existing indexed path fails and changes nothing (atomic)', () => {
	const db = openDb(tmpDbPath());
	upsertFile(db, file('a.md'), [chunk('a.md', 'x')]);
	upsertFile(db, file('b.md'), [chunk('b.md', 'y')]);
	assert.throws(() => renameFileInIndex(db, 'a.md', 'b.md'));
	assert.deepEqual(paths(db, 'files'), ['a.md', 'b.md']);
	assert.deepEqual(paths(db, 'chunks'), ['a.md', 'b.md']);
	db.close();
});

test('the deferred check does not weaken integrity: a rename that leaves chunks behind cannot commit', () => {
	const db = openDb(tmpDbPath());
	upsertFile(db, file('a.md'), [chunk('a.md', 'x')]);
	const halfRename = db.transaction(() => {
		db.pragma('defer_foreign_keys = ON');
		db.prepare('UPDATE files SET path = ? WHERE path = ?').run('b.md', 'a.md'); // chunks not updated
	});
	assert.throws(() => halfRename(), /FOREIGN KEY/);
	assert.deepEqual(paths(db, 'files'), ['a.md']);
	db.close();
});
