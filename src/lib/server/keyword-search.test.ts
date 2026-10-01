import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { hasKeywordIndex, keywordSearch, keywordSearchCoOccurring } from './keyword-search';
import { buildCoOccurrenceQuery } from './keyword-query';

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

function coSearch(db: Database.Database, question: string, limit = 5): number[] {
	const co = buildCoOccurrenceQuery(question);
	assert.ok(co, 'question should yield a co-occurrence query');
	return keywordSearchCoOccurring(db, co.expr, co.terms, limit).map((h) => h.chunkId);
}

test('co-occurrence: a chunk with two distinct terms is kept, one term repeated is dropped', () => {
	const db = freshFtsDb();
	insert(db, 1, 'Sorting', 'quicksort picks a pivot and partitions the array around it');
	insert(db, 2, 'Noise', 'pivot pivot pivot pivot pivot pivot');
	assert.deepEqual(coSearch(db, 'how does quicksort choose a pivot in practice'), [1]);
});

test('co-occurrence: terms absent from every chunk do not block a chunk holding two others (AND would)', () => {
	const db = freshFtsDb();
	insert(db, 1, 'B-tree', 'a b-tree index keeps keys sorted for range scans');
	assert.deepEqual(coSearch(db, 'why does a database index speed up range queries zebra'), [1]);
});

test('co-occurrence respects the index tokenizer (porter stemming, diacritics)', () => {
	const db = freshFtsDb();
	insert(db, 1, 'DB', 'the index structure makes lookups fast');
	insert(db, 2, 'Kalıp', 'ağaç yapısı');
	assert.deepEqual(coSearch(db, 'indexes lookups'), [1]);
	assert.deepEqual(coSearch(db, 'agac yapısı'), [2]);
});

test('co-occurrence keeps BM25 order and honours the limit', () => {
	const db = freshFtsDb();
	insert(db, 1, 'A', 'tcp protocol');
	insert(db, 2, 'B', 'tcp protocol tcp protocol tcp protocol handshake');
	insert(db, 3, 'C', 'tcp only here');
	const all = coSearch(db, 'tcp protocol', 5);
	assert.deepEqual([...all].sort(), [1, 2]);
	assert.equal(coSearch(db, 'tcp protocol', 1).length, 1);
	assert.equal(coSearch(db, 'tcp protocol', 1)[0], all[0]);
});

test('co-occurrence is not starved by a pool full of single-term hits', () => {
	const db = freshFtsDb();
	for (let i = 1; i <= 30; i++) insert(db, i, 'N', 'pivot pivot pivot pivot pivot pivot pivot pivot');
	insert(db, 100, 'Real', 'quicksort pivot selection');
	assert.deepEqual(coSearch(db, 'quicksort pivot'), [100]);
});

test('co-occurrence never throws: bad expression, bad limit, missing table', () => {
	const db = freshFtsDb();
	assert.deepEqual(keywordSearchCoOccurring(db, '"unterminated', ['a', 'b'], 5), []);
	assert.deepEqual(keywordSearchCoOccurring(db, '"a" OR "b"', ['a', 'b'], 0), []);
	assert.deepEqual(keywordSearchCoOccurring(new Database(':memory:'), '"a" OR "b"', ['a', 'b'], 5), []);
});
