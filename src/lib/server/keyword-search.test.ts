import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { hasKeywordIndex, keywordSearch } from './keyword-search';

/**
 * F9 — RAG Retrieval, the deterministic half: keyword-search.ts (the FTS5 fallback, F5) had no direct test at
 * all before this — only its query-BUILDING logic (keyword-query.test.ts), never a real search against a real
 * FTS5 index. Unlike retrieve.ts's vector path, this needs no Ollama embedding call, so it can cover the
 * spec's exact RAG-retrieval scenario (§55: "Document A has the answer, Document B has similar but incorrect
 * information — retrieve A, don't over-trust B") deterministically, in npm test.
 */

function freshFtsDb(): Database.Database {
	const db = new Database(':memory:');
	db.exec(`
		CREATE VIRTUAL TABLE chunks_fts USING fts5(
			heading_path,
			display_text,
			tokenize = 'porter unicode61 remove_diacritics 2'
		);
	`);
	return db;
}

function insert(db: Database.Database, rowid: number, headingPath: string, displayText: string): void {
	db.prepare('INSERT INTO chunks_fts (rowid, heading_path, display_text) VALUES (?, ?, ?)').run(rowid, headingPath, displayText);
}

test('hasKeywordIndex is true once chunks_fts exists, false on a DB without it', () => {
	assert.equal(hasKeywordIndex(freshFtsDb()), true);
	assert.equal(hasKeywordIndex(new Database(':memory:')), false);
});

test('the document that actually contains the answer is retrieved', () => {
	const db = freshFtsDb();
	insert(db, 1, 'B-ağacı', 'B-ağacının yüksekliği düğüm sayısına göre logaritmik olarak artar.');
	insert(db, 2, 'İkili arama ağacı', 'İkili arama ağacında arama, ekleme ve silme ortalama O(log n) sürer.');
	const hits = keywordSearch(db, '"b-ağacı" OR "yükseklik"', 5);
	assert.ok(hits.length > 0);
	assert.equal(hits[0].chunkId, 1);
});

test("spec §55's exact scenario: Document A has the answer, Document B is similar but wrong — A ranks first", () => {
	const db = freshFtsDb();
	// A: the real, correct definition, using the query terms densely and centrally.
	insert(db, 1, 'Normalizasyon — 3NF', 'Üçüncü normal form (3NF), her non-key özelliğin yalnızca aday anahtara bağımlı olmasını gerektirir; geçişli bağımlılık olmamalıdır.');
	// B: superficially similar (also about normal forms) but does not actually answer "3NF nedir" — a plausible
	// false-positive by term overlap alone, mentions 3NF only in passing while being about BCNF.
	insert(db, 2, 'BCNF', 'Boyce-Codd normal formu (BCNF), 3NF\'den daha katıdır ve her belirleyicinin bir aday anahtar olmasını ister.');
	const hits = keywordSearch(db, '"3NF"', 5);
	assert.ok(hits.length >= 2, 'both are legitimate keyword hits');
	assert.equal(hits[0].chunkId, 1, 'the chunk that is actually ABOUT 3NF outranks the one that only mentions it');
});

test('an unrelated document is not returned at all for a specific query', () => {
	const db = freshFtsDb();
	insert(db, 1, 'B-ağacı', 'B-ağacı dengeli bir arama ağacı türüdür.');
	insert(db, 2, 'SvelteKit yönlendirme', 'SvelteKit dosya tabanlı bir yönlendirme sistemi kullanır.');
	const hits = keywordSearch(db, '"b-ağacı"', 5);
	assert.deepEqual(hits.map((h) => h.chunkId), [1]);
});

test('limit is respected', () => {
	const db = freshFtsDb();
	for (let i = 1; i <= 5; i++) insert(db, i, `başlık ${i}`, 'ortak terim burada geçiyor');
	assert.equal(keywordSearch(db, '"ortak terim"', 2).length, 2);
});

test('limit < 1 (or not an integer) returns [] without querying', () => {
	const db = freshFtsDb();
	insert(db, 1, 'x', 'ortak terim');
	assert.deepEqual(keywordSearch(db, '"ortak terim"', 0), []);
	assert.deepEqual(keywordSearch(db, '"ortak terim"', -1), []);
	assert.deepEqual(keywordSearch(db, '"ortak terim"', 1.5), []);
});

test('a malformed MATCH expression never throws — returns [] (this only ever runs as a fallback)', () => {
	const db = freshFtsDb();
	insert(db, 1, 'x', 'içerik');
	assert.doesNotThrow(() => keywordSearch(db, 'AND OR (((', 5));
	assert.deepEqual(keywordSearch(db, 'AND OR (((', 5), []);
});

test('no matches at all returns []', () => {
	const db = freshFtsDb();
	insert(db, 1, 'x', 'tamamen alakasız bir içerik');
	assert.deepEqual(keywordSearch(db, '"hiç-geçmeyen-terim"', 5), []);
});
