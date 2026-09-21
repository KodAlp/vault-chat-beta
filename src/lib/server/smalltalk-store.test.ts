import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {
	MAX_PHRASE_CHARS,
	clearLearned,
	confirmQuestion,
	deletePhrase,
	ensureReady,
	initSmallTalkSchema,
	isReady,
	learn,
	listPhrases,
	loadPhrases,
	recordHit,
	type EmbedFn
} from './smalltalk-store';
import { SMALLTALK_SEEDS } from './smalltalk-seeds';
import { decideSmallTalk, normalize } from './smalltalk-gate';

/** Character-frequency vectors: similar spellings are close, different words are not. Deterministic, no model. */
function charVec(text: string): number[] {
	const v = new Array(64).fill(0);
	for (const ch of text.toLowerCase()) v[ch.charCodeAt(0) % 64] += 1;
	return v;
}

function fakeEmbed(): { embed: EmbedFn; calls: string[][] } {
	const calls: string[][] = [];
	return {
		calls,
		embed: async (texts) => {
			calls.push([...texts]);
			return texts.map(charVec);
		}
	};
}

function fresh(): Database.Database {
	const db = new Database(':memory:');
	initSmallTalkSchema(db);
	return db;
}

const M = 'bge-m3';

test('the schema can be created twice', () => {
	const db = fresh();
	assert.doesNotThrow(() => initSmallTalkSchema(db));
});

test('ensureReady embeds the seeds once and keeps them; a second call embeds nothing', async () => {
	const db = fresh();
	const { embed, calls } = fakeEmbed();
	assert.equal(isReady(db, M), false);
	await ensureReady(db, embed, M);
	assert.equal(isReady(db, M), true);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].length, SMALLTALK_SEEDS.length);
	await ensureReady(db, embed, M);
	assert.equal(calls.length, 1);
	const phrases = loadPhrases(db, M);
	assert.equal(phrases.length, SMALLTALK_SEEDS.length);
	assert.ok(phrases.every((p) => p.source === 'seed' && p.kind === 'smalltalk' && !p.blocked));
	const len = Math.sqrt([...phrases[0].vec].reduce((s, x) => s + x * x, 0));
	assert.ok(Math.abs(len - 1) < 1e-5, 'stored vectors are unit length');
});

test('concurrent ensureReady calls share one run', async () => {
	const db = fresh();
	const { embed, calls } = fakeEmbed();
	await Promise.all([ensureReady(db, embed, M), ensureReady(db, embed, M), ensureReady(db, embed, M)]);
	assert.equal(calls.length, 1);
});

test('only the missing seeds are embedded', async () => {
	const db = fresh();
	const { embed, calls } = fakeEmbed();
	await ensureReady(db, embed, M);
	db.prepare("DELETE FROM smalltalk_phrases WHERE text = 'merhaba'").run();
	await ensureReady(db, embed, M);
	assert.deepEqual(calls[1], ['merhaba']);
});

test('rows from another embedding model are re-embedded from their text, not lost', async () => {
	const db = fresh();
	const { embed } = fakeEmbed();
	await ensureReady(db, embed, 'old-model');
	learn(db, 'old-model', 'napıyon lan', charVec('napıyon lan'), 'user');
	assert.equal(isReady(db, 'new-model'), false);
	await ensureReady(db, embed, 'new-model');
	assert.equal(isReady(db, 'new-model'), true);
	assert.equal(loadPhrases(db, 'old-model').length, 0);
	assert.ok(listPhrases(db).some((p) => p.text === 'napıyon lan'));
	assert.equal(loadPhrases(db, 'new-model').length, SMALLTALK_SEEDS.length + 1);
});

test('learn stores a short phrase, tidied, and the gate sees it immediately', async () => {
	const db = fresh();
	const { embed } = fakeEmbed();
	await ensureReady(db, embed, M);
	const r = learn(db, M, '  sup   dawg ', charVec('sup dawg'), 'user');
	assert.deepEqual({ created: r?.created }, { created: true });
	assert.equal(listPhrases(db)[0].text, 'sup dawg');
	const decision = decideSmallTalk(charVec('sup dawg'), 0.3, loadPhrases(db, M));
	assert.equal(decision.smallTalk, true);
	assert.equal(decision.via, 'personal');
});

test('learn refuses empty text, text too long to be small talk, and returns a duplicate as a hit', async () => {
	const db = fresh();
	const { embed } = fakeEmbed();
	await ensureReady(db, embed, M);
	assert.equal(learn(db, M, '   ', charVec('x'), 'auto'), null);
	assert.equal(learn(db, M, 'a'.repeat(MAX_PHRASE_CHARS + 1), charVec('aaa'), 'auto'), null);
	const first = learn(db, M, 'yo yo', charVec('yo yo'), 'auto')!;
	const again = learn(db, M, 'yo yo', charVec('yo yo'), 'auto')!;
	assert.equal(again.created, false);
	assert.equal(again.id, first.id);
	assert.equal(listPhrases(db).find((p) => p.id === first.id)!.hits, 1);
});

test('a message already identical to a seed is a hit on the seed, not a new row', async () => {
	const db = fresh();
	const { embed } = fakeEmbed();
	await ensureReady(db, embed, M);
	const before = loadPhrases(db, M).length;
	const r = learn(db, M, 'merhaba', charVec('merhaba'), 'auto')!;
	assert.equal(r.created, false);
	assert.equal(loadPhrases(db, M).length, before);
});

test('confirmQuestion blocks the learned phrase that misfired, never a seed, and vetoes the question afterwards', async () => {
	const db = fresh();
	const { embed } = fakeEmbed();
	await ensureReady(db, embed, M);
	const learned = learn(db, M, 'selam abi', charVec('selam abi'), 'auto')!;
	const seed = loadPhrases(db, M).find((p) => p.source === 'seed')!;

	confirmQuestion(db, M, 'selam abi nedir dijkstra', charVec('selam abi nedir dijkstra'), learned.id);
	confirmQuestion(db, M, 'selam abi nedir dijkstra', charVec('selam abi nedir dijkstra'), seed.id);

	const phrases = loadPhrases(db, M);
	assert.equal(phrases.find((p) => p.id === learned.id)!.blocked, true);
	assert.equal(phrases.find((p) => p.id === seed.id)!.blocked, false, 'a seed is never blocked by one override');
	assert.equal(phrases.filter((p) => p.kind === 'question').length, 1, 'the same question is stored once');
	// the confirmed question now vetoes even a strong seed match
	const d = decideSmallTalk(charVec('selam abi nedir dijkstra'), 0.6, phrases);
	assert.equal(d.smallTalk, false);
});

test('a phrase the user re-teaches on purpose is unblocked; auto-learning cannot undo a confirmed question', async () => {
	const db = fresh();
	const { embed } = fakeEmbed();
	await ensureReady(db, embed, M);
	const learned = learn(db, M, 'hadi bakalım', charVec('hadi bakalım'), 'auto')!;
	confirmQuestion(db, M, 'baska bir metin', charVec('baska bir metin'), learned.id);
	assert.equal(loadPhrases(db, M).find((p) => p.id === learned.id)!.blocked, true);
	assert.equal(learn(db, M, 'hadi bakalım', charVec('hadi bakalım'), 'user')!.id, learned.id);
	assert.equal(loadPhrases(db, M).find((p) => p.id === learned.id)!.blocked, false);
});

test('learn refuses a message the user confirmed is a question', async () => {
	const db = fresh();
	const { embed } = fakeEmbed();
	await ensureReady(db, embed, M);
	confirmQuestion(db, M, 'selam asm nedir', charVec('selam asm nedir'));
	assert.equal(learn(db, M, 'selam asm nedir', charVec('selam asm nedir'), 'auto'), null);
});

test('over the limit the least recently used phrase goes first, confirmed questions last', async () => {
	const db = fresh();
	const { embed } = fakeEmbed();
	await ensureReady(db, embed, M);
	confirmQuestion(db, M, 'zzzz qqqq', charVec('zzzz qqqq'));
	const a = learn(db, M, 'aaaaa bbbbb', charVec('aaaaa bbbbb'), 'auto', { maxLearned: 3 })!;
	learn(db, M, 'ccccc ddddd', charVec('ccccc ddddd'), 'auto', { maxLearned: 3 });
	learn(db, M, 'eeeee fffff', charVec('eeeee fffff'), 'auto', { maxLearned: 3 });
	const list = listPhrases(db);
	assert.equal(list.length, 3);
	assert.ok(!list.some((p) => p.id === a.id), 'the oldest smalltalk phrase was evicted');
	assert.ok(list.some((p) => p.kind === 'question'), 'the confirmed question survived');
});

test('list, delete and clear: seeds are switched off rather than deleted, and clear restores them', async () => {
	const db = fresh();
	const { embed } = fakeEmbed();
	await ensureReady(db, embed, M);
	const learned = learn(db, M, 'kral naber', charVec('kral naber'), 'auto')!;
	const seed = loadPhrases(db, M).find((p) => p.source === 'seed')!;

	assert.deepEqual(listPhrases(db).map((p) => p.id), [learned.id], 'active seeds are not listed');
	assert.equal(deletePhrase(db, seed.id), true);
	assert.ok(listPhrases(db).some((p) => p.id === seed.id && p.blocked), 'a switched-off seed is listed');
	assert.equal(loadPhrases(db, M).find((p) => p.id === seed.id)!.blocked, true);
	assert.equal(deletePhrase(db, learned.id), true);
	assert.equal(deletePhrase(db, 99999), false);

	learn(db, M, 'ooo kimleri görüyorum', charVec('ooo kimleri görüyorum'), 'user');
	assert.equal(clearLearned(db), 1);
	assert.deepEqual(listPhrases(db), []);
	assert.equal(loadPhrases(db, M).find((p) => p.id === seed.id)!.blocked, false);
	assert.equal(loadPhrases(db, M).length, SMALLTALK_SEEDS.length);
});

test('recordHit counts and timestamps a hit', async () => {
	const db = fresh();
	const { embed } = fakeEmbed();
	await ensureReady(db, embed, M);
	const learned = learn(db, M, 'napıyoz', charVec('napıyoz'), 'auto')!;
	recordHit(db, learned.id);
	recordHit(db, learned.id);
	const item = listPhrases(db).find((p) => p.id === learned.id)!;
	assert.equal(item.hits, 2);
	assert.ok(item.lastHitAt);
});

test('vectors survive the round trip through the BLOB unchanged', async () => {
	const db = fresh();
	const { embed } = fakeEmbed();
	await ensureReady(db, embed, M);
	const want = normalize(charVec('merhaba'));
	// seeds are inserted in list order, so their ids follow it
	const got = loadPhrases(db, M)[SMALLTALK_SEEDS.indexOf('merhaba')];
	for (let i = 0; i < want.length; i++) assert.ok(Math.abs(want[i] - got.vec[i]) < 1e-6);
});
