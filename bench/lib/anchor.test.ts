import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { buildAnchorIndex, chunkAnchor, normalizeChunkText, resolveQrels } from './anchor';

function memDb(): Database.Database {
	const db = new Database(':memory:');
	db.exec(`
		CREATE TABLE chunks (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			path TEXT NOT NULL,
			heading_path TEXT NOT NULL,
			display_text TEXT NOT NULL
		);
	`);
	return db;
}

const insertChunk = (db: Database.Database, path: string, heading: string, text: string) =>
	db.prepare('INSERT INTO chunks (path, heading_path, display_text) VALUES (?, ?, ?)').run(path, heading, text);

test('normalizeChunkText collapses CRLF and whitespace runs, and trims', () => {
	assert.equal(normalizeChunkText('a\r\nb   c\t\td\n'), 'a b c d');
	assert.equal(normalizeChunkText('  leading and trailing  '), 'leading and trailing');
});

test('normalizeChunkText normalizes to NFC (composed vs. decomposed Unicode hash the same)', () => {
	const decomposed = 'é'; // e + combining acute accent
	const composed = 'é'; // é, precomposed
	assert.equal(normalizeChunkText(decomposed), normalizeChunkText(composed));
});

test('chunkAnchor is stable across whitespace/CRLF differences', () => {
	const a = chunkAnchor({ path: 'a.md', heading_path: 'H', display_text: 'line one\r\nline two' });
	const b = chunkAnchor({ path: 'a.md', heading_path: 'H', display_text: 'line one\nline   two  ' });
	assert.equal(a, b);
});

test('chunkAnchor changes when the text changes', () => {
	const a = chunkAnchor({ path: 'a.md', heading_path: 'H', display_text: 'one' });
	const b = chunkAnchor({ path: 'a.md', heading_path: 'H', display_text: 'two' });
	assert.notEqual(a, b);
});

test('chunkAnchor changes when the heading changes', () => {
	const a = chunkAnchor({ path: 'a.md', heading_path: 'H1', display_text: 'same' });
	const b = chunkAnchor({ path: 'a.md', heading_path: 'H2', display_text: 'same' });
	assert.notEqual(a, b);
});

test('chunkAnchor changes when the path changes', () => {
	const a = chunkAnchor({ path: 'a.md', heading_path: 'H', display_text: 'same' });
	const b = chunkAnchor({ path: 'b.md', heading_path: 'H', display_text: 'same' });
	assert.notEqual(a, b);
});

test('chunkAnchor has the a_ prefix and 12 lowercase hex chars', () => {
	const anchor = chunkAnchor({ path: 'a.md', heading_path: 'H', display_text: 'x' });
	assert.match(anchor, /^a_[0-9a-f]{12}$/);
});

test('buildAnchorIndex maps anchors to chunk ids and resolves the anchor back to a path', () => {
	const db = memDb();
	insertChunk(db, 'a.md', 'H', 'hello world');
	const index = buildAnchorIndex(db);
	assert.equal(index.byId.size, 1);
	const [id] = [...index.byId.keys()];
	const entry = index.byId.get(id)!;
	assert.equal(entry.path, 'a.md');
	assert.deepEqual(index.byAnchor.get(entry.anchor), [id]);
	assert.equal(index.pathOf(entry.anchor), 'a.md');
	assert.equal(index.pathOf('a_000000000000'), undefined);
	db.close();
});

test('buildAnchorIndex does not write to the db', () => {
	const db = memDb();
	insertChunk(db, 'a.md', 'H', 'hello world');
	buildAnchorIndex(db);
	assert.equal((db.prepare('SELECT count(*) AS c FROM chunks').get() as { c: number }).c, 1);
	db.close();
});

test('resolveQrels: exact when the anchor still exists in the index', () => {
	const db = memDb();
	insertChunk(db, 'a.md', 'H', 'hello world');
	const index = buildAnchorIndex(db);
	const anchor = chunkAnchor({ path: 'a.md', heading_path: 'H', display_text: 'hello world' });
	const resolved = resolveQrels([{ anchor, path: 'a.md', grade: 2 }], index);
	assert.deepEqual(resolved, [{ anchor, path: 'a.md', grade: 2, status: 'exact' }]);
	db.close();
});

test('resolveQrels: file-only when the anchor is gone but the path still has chunks (note re-edited)', () => {
	const db = memDb();
	insertChunk(db, 'a.md', 'H', 'edited content'); // same path, content changed since labeling
	const index = buildAnchorIndex(db);
	const staleAnchor = chunkAnchor({ path: 'a.md', heading_path: 'H', display_text: 'original content' });
	const resolved = resolveQrels([{ anchor: staleAnchor, path: 'a.md', grade: 2 }], index);
	assert.equal(resolved[0].status, 'file-only');
	db.close();
});

test('resolveQrels: missing when neither the anchor nor the path exists (file deleted/renamed)', () => {
	const db = memDb();
	insertChunk(db, 'other.md', 'H', 'unrelated text');
	const index = buildAnchorIndex(db);
	const anchor = chunkAnchor({ path: 'deleted.md', heading_path: 'H', display_text: 'gone' });
	const resolved = resolveQrels([{ anchor, path: 'deleted.md', grade: 1 }], index);
	assert.equal(resolved[0].status, 'missing');
	db.close();
});

test('resolveQrels resolves a mixed batch independently', () => {
	const db = memDb();
	insertChunk(db, 'a.md', 'H', 'kept content');
	insertChunk(db, 'b.md', 'H', 'edited content');
	const index = buildAnchorIndex(db);
	const exactAnchor = chunkAnchor({ path: 'a.md', heading_path: 'H', display_text: 'kept content' });
	const staleAnchor = chunkAnchor({ path: 'b.md', heading_path: 'H', display_text: 'original content' });
	const goneAnchor = chunkAnchor({ path: 'c.md', heading_path: 'H', display_text: 'gone' });
	const resolved = resolveQrels(
		[
			{ anchor: exactAnchor, path: 'a.md', grade: 2 },
			{ anchor: staleAnchor, path: 'b.md', grade: 2 },
			{ anchor: goneAnchor, path: 'c.md', grade: 1 }
		],
		index
	);
	assert.deepEqual(
		resolved.map((r) => r.status),
		['exact', 'file-only', 'missing']
	);
	db.close();
});
