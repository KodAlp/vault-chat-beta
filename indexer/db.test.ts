import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { deleteFile, openDb, renameFileInIndex, syncFts, upsertFile, type FileRow } from './db';
import { EMBED_DIMS } from '../src/lib/server/embed-config';
import { hasKeywordIndex, keywordSearch } from '../src/lib/server/keyword-search';

function tmpDbPath(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-fts-'));
	return path.join(dir, 'index.db');
}

const zero = () => Array.from({ length: EMBED_DIMS }, () => 0);
const file = (p: string): FileRow => ({ path: p, sha256: 'x', mtime: 1, topic: 't', depth: 'undergrad', domains_json: '[]' });
const chunk = (p: string, heading: string, text: string) => ({ insert: { path: p, heading_path: heading, display_text: text }, embedding: zero() });
const count = (db: Database.Database, table: string) => (db.prepare(`SELECT count(*) AS c FROM ${table}`).get() as { c: number }).c;
const find = (db: Database.Database, expr: string) => keywordSearch(db, expr, 20).map((h) => h.chunkId);

test('a fresh index has the keyword table', () => {
	const db = openDb(tmpDbPath());
	assert.equal(hasKeywordIndex(db), true);
	assert.equal(count(db, 'chunks_fts'), 0);
	db.close();
});

test('upsertFile keeps chunks_fts in step and its rowids equal chunks.id', () => {
	const db = openDb(tmpDbPath());
	upsertFile(db, file('a.md'), [chunk('a.md', 'A > B-tree', 'A B-tree keeps keys sorted.'), chunk('a.md', 'A > Hash', 'A hash table maps keys to buckets.')]);
	assert.equal(count(db, 'chunks'), 2);
	assert.equal(count(db, 'chunks_fts'), 2);
	const ids = (db.prepare('SELECT id FROM chunks ORDER BY id').all() as { id: number }[]).map((r) => r.id);
	assert.deepEqual(find(db, '"btree" OR "tree"').sort(), [ids[0]]);
	assert.deepEqual(find(db, '"buckets"'), [ids[1]]);
	db.close();
});

test('the heading is searchable too, not only the body', () => {
	const db = openDb(tmpDbPath());
	upsertFile(db, file('a.md'), [chunk('a.md', 'Sorting > Quicksort', 'Pick a pivot and partition.')]);
	assert.equal(find(db, '"quicksort"').length, 1);
	db.close();
});

test('re-upserting a file replaces its rows: no duplicates, old text is gone', () => {
	const db = openDb(tmpDbPath());
	upsertFile(db, file('a.md'), [chunk('a.md', 'h', 'oldterm content')]);
	upsertFile(db, file('a.md'), [chunk('a.md', 'h', 'newterm content')]);
	assert.equal(count(db, 'chunks'), 1);
	assert.equal(count(db, 'chunks_fts'), 1);
	assert.deepEqual(find(db, '"oldterm"'), []);
	assert.equal(find(db, '"newterm"').length, 1);
	db.close();
});

test('deleteFile removes the file\'s keyword rows and leaves the others', () => {
	const db = openDb(tmpDbPath());
	upsertFile(db, file('a.md'), [chunk('a.md', 'h', 'alpha unique')]);
	upsertFile(db, file('b.md'), [chunk('b.md', 'h', 'beta unique')]);
	deleteFile(db, 'a.md');
	assert.equal(count(db, 'chunks_fts'), 1);
	assert.deepEqual(find(db, '"alpha"'), []);
	assert.equal(find(db, '"beta"').length, 1);
	db.close();
});

test('renaming a file keeps its keyword rows valid (they do not store the path)', () => {
	const db = openDb(tmpDbPath());
	upsertFile(db, file('old.md'), [chunk('old.md', 'h', 'renameable phrase')]);
	renameFileInIndex(db, 'old.md', 'new/dir.md');
	assert.equal(find(db, '"renameable"').length, 1);
	const row = db.prepare('SELECT c.path FROM chunks c WHERE c.id = ?').get(find(db, '"renameable"')[0]) as { path: string };
	assert.equal(row.path, 'new/dir.md');
	db.close();
});

test('bm25 ranks the better match first (lower score is better)', () => {
	const db = openDb(tmpDbPath());
	upsertFile(db, file('a.md'), [chunk('a.md', 'h', 'index index index structure'), chunk('a.md', 'h2', 'a passing mention of index only')]);
	const hits = keywordSearch(db, '"index"', 10);
	assert.equal(hits.length, 2);
	assert.ok(hits[0].score <= hits[1].score);
	assert.equal(hits[0].chunkId, (db.prepare("SELECT id FROM chunks WHERE display_text LIKE 'index index%'").get() as { id: number }).id);
	db.close();
});

test('English stemming and Turkish diacritic folding apply to the index and the query alike', () => {
	const db = openDb(tmpDbPath());
	upsertFile(db, file('a.md'), [chunk('a.md', 'h', 'Indexing speeds lookups.'), chunk('a.md', 'h2', 'seker pancarindan uretilir')]);
	assert.equal(find(db, '"index"').length, 1, 'porter: index ~ indexing');
	assert.equal(find(db, '"şeker"').length, 1, 'diacritics: şeker ~ seker');
	db.close();
});

test('an index built before the keyword table existed is filled from chunks on the next open', () => {
	const p = tmpDbPath();
	let db = openDb(p);
	upsertFile(db, file('a.md'), [chunk('a.md', 'h', 'legacy alpha'), chunk('a.md', 'h2', 'legacy beta')]);
	db.exec('DROP TABLE chunks_fts'); // what a pre-F5 index looks like
	db.close();

	const ro = new Database(p, { readonly: true });
	assert.equal(hasKeywordIndex(ro), false, 'a read-only handle cannot create it');
	assert.deepEqual(keywordSearch(ro, '"alpha"', 5), [], 'and searching without the table is "no hits", not an error');
	ro.close();

	db = openDb(p); // = `npm run index -- --fts`
	assert.equal(count(db, 'chunks_fts'), 2);
	assert.equal(find(db, '"beta"').length, 1);
	db.close();
});

test('syncFts repairs drift in both directions and is a no-op when nothing drifted', () => {
	const db = openDb(tmpDbPath());
	upsertFile(db, file('a.md'), [chunk('a.md', 'h', 'one'), chunk('a.md', 'h2', 'two'), chunk('a.md', 'h3', 'three')]);
	assert.deepEqual(syncFts(db), { added: 0, removed: 0 });

	const ids = (db.prepare('SELECT id FROM chunks ORDER BY id').all() as { id: number }[]).map((r) => r.id);
	db.prepare('DELETE FROM chunks_fts WHERE rowid IN (?, ?)').run(ids[0], ids[1]); // two rows missing
	db.prepare('INSERT INTO chunks_fts (rowid, heading_path, display_text) VALUES (?, ?, ?)').run(99999, 'stray', 'stray row'); // one orphan
	assert.deepEqual(syncFts(db), { added: 2, removed: 1 });
	assert.equal(count(db, 'chunks_fts'), 3);
	assert.deepEqual(find(db, '"stray"'), []);
	assert.equal(find(db, '"one"').length, 1);
	assert.deepEqual(syncFts(db), { added: 0, removed: 0 });
	db.close();
});

test('opening the index again is idempotent', () => {
	const p = tmpDbPath();
	let db = openDb(p);
	upsertFile(db, file('a.md'), [chunk('a.md', 'h', 'stable text')]);
	db.close();
	for (let i = 0; i < 3; i++) {
		db = openDb(p);
		assert.equal(count(db, 'chunks_fts'), 1);
		db.close();
	}
});

test('a failed upsert rolls the keyword rows back with the rest', () => {
	const db = openDb(tmpDbPath());
	const bad = { insert: { path: 'a.md', heading_path: 'h', display_text: 'text that must not survive' }, embedding: [1, 2, 3] }; // wrong dimensions
	assert.throws(() => upsertFile(db, file('a.md'), [bad]));
	assert.equal(count(db, 'files'), 0);
	assert.equal(count(db, 'chunks'), 0);
	assert.equal(count(db, 'chunks_fts'), 0);
	db.close();
});

test('keywordSearch never throws on a malformed expression or a bad limit', () => {
	const db = openDb(tmpDbPath());
	upsertFile(db, file('a.md'), [chunk('a.md', 'h', 'some text')]);
	assert.deepEqual(keywordSearch(db, '"unterminated', 5), []);
	assert.deepEqual(keywordSearch(db, 'AND OR', 5), []);
	assert.deepEqual(keywordSearch(db, '"some"', 0), []);
	assert.deepEqual(keywordSearch(db, '"some"', -1), []);
	assert.equal(keywordSearch(db, '"some"', 5).length, 1);
	db.close();
});
