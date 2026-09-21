import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { buildFallbackQuery, buildFtsQuery, extractTerms, MAX_FTS_TERMS } from './keyword-query';

test('content words survive, question words and articles are dropped', () => {
	assert.deepEqual(extractTerms('B-tree indeksi nedir?'), ['tree', 'indeksi']);
	assert.deepEqual(extractTerms('What is the difference between TCP and UDP?'), ['difference', 'between', 'tcp', 'udp']);
});

test('terms are lowercased and de-duplicated', () => {
	assert.deepEqual(extractTerms('Index INDEX index'), ['index']);
});

test('digits, underscores and Turkish letters are kept', () => {
	assert.deepEqual(extractTerms('sha256 heading_path şeker ığdır 2026'), ['sha256', 'heading_path', 'şeker', 'ığdır', '2026']);
});

test('one-letter fragments are dropped', () => {
	assert.deepEqual(extractTerms('a b c x y z'), []);
	assert.deepEqual(extractTerms('C++ ve C#'), []);
});

test('a question with no usable term yields null, not an empty match', () => {
	assert.equal(buildFtsQuery('nedir? ne?'), null);
	assert.equal(buildFtsQuery(''), null);
	assert.equal(buildFtsQuery('   '), null);
	assert.equal(buildFtsQuery('!!! ??? ...'), null);
});

test('every term is double-quoted; OR is the default, AND on request', () => {
	assert.equal(buildFtsQuery('binary search tree'), '"binary" OR "search" OR "tree"');
	assert.equal(buildFtsQuery('binary search tree', 'and'), '"binary" AND "search" AND "tree"');
});

test('no more than MAX_FTS_TERMS terms, keeping the longer (rarer) ones', () => {
	const words = Array.from({ length: 30 }, (_, i) => 'w'.repeat(2 + (i % 5)) + String(i));
	const terms = extractTerms(words.join(' '));
	assert.equal(terms.length, MAX_FTS_TERMS);
	const kept = Math.min(...terms.map((t) => t.length));
	const dropped = words.filter((w) => !terms.includes(w.toLowerCase()));
	assert.ok(dropped.every((w) => w.length <= kept), 'nothing shorter than the shortest kept term was preferred');
});

test('FTS5 syntax in the question cannot escape the quoting', () => {
	const hostile = [
		'foo" OR "bar',
		'NEAR(a b, 5)',
		'title:secret OR heading_path:x',
		'a* b*',
		'(x AND y) NOT z',
		'"unterminated',
		"'; DROP TABLE chunks; --",
		'AND OR NOT NEAR'
	];
	for (const q of hostile) {
		const built = buildFtsQuery(q);
		if (built === null) continue;
		// nothing but quoted terms and the OR connector may remain
		assert.match(built, /^"[\p{L}\p{N}_]+"( OR "[\p{L}\p{N}_]+")*$/u, `unsafe expression for ${JSON.stringify(q)}: ${built}`);
	}
});

// ---- the built expression must also be valid FTS5 and behave

function fts(rows: string[]) {
	const db = new Database(':memory:');
	db.exec(`CREATE VIRTUAL TABLE t USING fts5(body, tokenize='porter unicode61 remove_diacritics 2')`);
	const ins = db.prepare('INSERT INTO t(rowid, body) VALUES (?, ?)');
	rows.forEach((r, i) => ins.run(i + 1, r));
	return (expr: string) => (db.prepare('SELECT rowid FROM t WHERE t MATCH ? ORDER BY bm25(t)').all(expr) as { rowid: number }[]).map((r) => r.rowid);
}

test('the expression runs in a real FTS5 table and finds the right rows', () => {
	const search = fts(['a B-tree keeps keys sorted for fast lookup', 'TCP is a reliable transport protocol', 'unrelated cooking recipe with butter']);
	assert.deepEqual(search(buildFtsQuery('B-tree lookup')!), [1]);
	assert.deepEqual(search(buildFtsQuery('tcp protocol')!), [2]);
	assert.deepEqual(search(buildFtsQuery('tcp protocol', 'and')!), [2]);
});

test('AND is stricter than OR', () => {
	const search = fts(['alpha beta', 'alpha gamma', 'beta gamma']);
	assert.equal(search(buildFtsQuery('alpha beta', 'or')!).length, 3);
	assert.deepEqual(search(buildFtsQuery('alpha beta', 'and')!), [1]);
});

test('hostile input never throws in FTS5 and never matches everything by injection', () => {
	const search = fts(['secret salary table', 'public readme', 'another public note']);
	for (const q of ['secret" OR "public', 'NEAR(secret public)', '* OR *', 'title:secret', '"']) {
		const built = buildFtsQuery(q);
		if (built === null) continue;
		assert.doesNotThrow(() => search(built), `threw for ${JSON.stringify(q)}`);
	}
	// "secret" OR "public" is a legitimate OR of two TERMS here (both words are content words)
	assert.deepEqual(search(buildFtsQuery('secret" OR "public')!).sort(), [1, 2, 3]);
	// but a column filter is not interpreted: it is just two ordinary words
	assert.deepEqual(search(buildFtsQuery('title:secret')!), [1]);
});

test('Turkish diacritics fold the same way FTS5 does (şeker matches seker)', () => {
	const search = fts(['seker pancarindan uretilir', 'baska bir metin']);
	assert.deepEqual(search(buildFtsQuery('şeker')!), [1]);
});

// ---- the fallback's acceptance gate

test('the fallback needs two content terms: one stray word is not evidence', () => {
	for (const q of ['Merhaba', 'sup', 'neden?', 'nabıyon', 'dijkstra', 'ok', '']) {
		assert.equal(buildFallbackQuery(q), null, JSON.stringify(q));
	}
	assert.equal(buildFallbackQuery('FreeRTOS task scheduling'), '"freertos" AND "task" AND "scheduling"');
	assert.equal(buildFallbackQuery('big-o notation'), '"big" AND "notation"');
});

test('greetings and slang in any language match nothing unless their words co-occur', () => {
	// Every word below occurs somewhere in the corpus ON ITS OWN — that is what made the
	// old OR pass return unrelated chunks for small talk — but never together in a chunk.
	const search = fts([
		'the dawg barked at the mailman',
		'sup with the build pipeline',
		'napıyon appears in this row alone',
		'lan cable and ethernet switch',
		'göt is in this one only',
		'hey ho let us go',
		'there is a bro code',
		'a hell of a bug'
	]);
	const messages = ['sup dawg', 'napıyon lan göt', 'hey there bro', "what's up bro", 'what the hell', 'yo yo yo', 'Merhaba nasılsın'];
	for (const msg of messages) {
		const expr = buildFallbackQuery(msg);
		if (expr === null) continue;
		assert.deepEqual(search(expr), [], msg);
	}
	// the contrast that motivates the gate: OR would have returned something for these
	assert.ok(search(buildFtsQuery('sup dawg', 'or')!).length > 0);
	assert.ok(search(buildFtsQuery('napıyon lan göt', 'or')!).length > 0);
});

test('two terms that really co-occur do pass the gate', () => {
	const search = fts(['TCP is a reliable transport protocol', 'protocol buffers are a serialization format', 'tcpdump captures packets']);
	assert.deepEqual(search(buildFallbackQuery('tcp protocol')!), [1]);
});

test('the fallback expression is only quoted terms joined by AND, whatever the input', () => {
	for (const q of ['foo" OR "bar baz', 'NEAR(a b, 5) c', 'title:secret heading_path:x', '(x AND y) NOT zz']) {
		const built = buildFallbackQuery(q);
		if (built === null) continue;
		assert.match(built, /^"[\p{L}\p{N}_]+"( AND "[\p{L}\p{N}_]+")+$/u, `unsafe expression for ${JSON.stringify(q)}: ${built}`);
	}
});
