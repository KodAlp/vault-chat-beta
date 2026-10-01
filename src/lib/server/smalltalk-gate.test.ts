import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	decideSmallTalk,
	dot,
	isGateCalibratedFor,
	normalize,
	smallTalkGateEnabled,
	NEGATIVE_SIM,
	PERSONAL_SIM,
	SEED_MIN_CORPUS_DIST,
	SEED_SIM,
	type GatePhrase,
	type PhraseKind,
	type PhraseSource
} from './smalltalk-gate';

// The query is always [1, 0, 0]; a phrase at similarity `sim` is [sim, sqrt(1 - sim^2), 0].
const QUERY = [1, 0, 0];
function phrase(id: number, sim: number, source: PhraseSource = 'user', kind: PhraseKind = 'smalltalk', blocked = false): GatePhrase {
	return { id, source, kind, blocked, vec: normalize([sim, Math.sqrt(Math.max(0, 1 - sim * sim)), 0]) };
}

test('normalize gives unit length and dot of a vector with itself is 1', () => {
	const v = normalize([3, 4, 0]);
	assert.ok(Math.abs(dot(v, v) - 1) < 1e-6);
	assert.deepEqual([...normalize([0, 0, 0])], [0, 0, 0]);
});

test('a vector from another embedding model (different length) never matches', () => {
	assert.equal(dot([1, 0], [1, 0, 0]), -1);
	const p: GatePhrase = { id: 1, source: 'user', kind: 'smalltalk', blocked: false, vec: normalize([1, 0]) };
	assert.equal(decideSmallTalk(QUERY, 0.6, [p]).smallTalk, false);
});

test('a phrase the user said or taught flags at PERSONAL_SIM and above, not below', () => {
	assert.deepEqual(
		{ ...decideSmallTalk(QUERY, 0.3, [phrase(7, PERSONAL_SIM + 0.01)]), sim: 0 },
		{ smallTalk: true, via: 'personal', phraseId: 7, phraseSource: 'user', sim: 0 }
	);
	assert.equal(decideSmallTalk(QUERY, 0.3, [phrase(7, PERSONAL_SIM - 0.01)]).smallTalk, false);
});

test('a personal match ignores the corpus distance (a repeat of a known phrase is small talk even next to a good chunk)', () => {
	assert.equal(decideSmallTalk(QUERY, 0.2, [phrase(1, 0.9, 'auto')]).smallTalk, true);
});

test('a seed between SEED_SIM and PERSONAL_SIM also needs the corpus to have nothing close', () => {
	const mid = (SEED_SIM + PERSONAL_SIM) / 2;
	const seeds = [phrase(1, mid, 'seed')];
	assert.equal(decideSmallTalk(QUERY, SEED_MIN_CORPUS_DIST + 0.05, seeds).smallTalk, true);
	assert.equal(decideSmallTalk(QUERY, SEED_MIN_CORPUS_DIST - 0.05, seeds).smallTalk, false);
	// no KNN result at all: nothing to be close to
	assert.equal(decideSmallTalk(QUERY, undefined, seeds).smallTalk, true);
});

test('a seed below SEED_SIM never flags, whatever the corpus says', () => {
	assert.equal(decideSmallTalk(QUERY, 0.9, [phrase(1, SEED_SIM - 0.02, 'seed')]).smallTalk, false);
});

test('a seed at PERSONAL_SIM and above flags via "seed" (the only route that learns)', () => {
	const d = decideSmallTalk(QUERY, 0.3, [phrase(3, 0.95, 'seed')]);
	assert.equal(d.smallTalk, true);
	assert.equal(d.via, 'seed');
});

test('a personal phrase between SEED_SIM and PERSONAL_SIM does not flag (the looser seed rule is for seeds only)', () => {
	const mid = (SEED_SIM + PERSONAL_SIM) / 2;
	assert.equal(decideSmallTalk(QUERY, 0.9, [phrase(1, mid, 'user')]).smallTalk, false);
});

test('a blocked phrase no longer matches', () => {
	assert.equal(decideSmallTalk(QUERY, 0.9, [phrase(1, 0.95, 'auto', 'smalltalk', true)]).smallTalk, false);
});

test('a confirmed question vetoes a flag when the message is that close to it', () => {
	const flagged = phrase(1, 0.95, 'seed');
	const veto = decideSmallTalk(QUERY, 0.6, [flagged, phrase(2, NEGATIVE_SIM + 0.02, 'user', 'question')]);
	assert.equal(veto.smallTalk, false);
	assert.equal(veto.vetoed, true);
	// a question that is not close enough changes nothing
	assert.equal(decideSmallTalk(QUERY, 0.6, [flagged, phrase(2, NEGATIVE_SIM - 0.05, 'user', 'question')]).smallTalk, true);
});

test('a question phrase is never itself a small-talk match', () => {
	assert.equal(decideSmallTalk(QUERY, 0.6, [phrase(2, 0.99, 'user', 'question')]).smallTalk, false);
});

test('the closest small-talk phrase is reported, flagged or not', () => {
	const d = decideSmallTalk(QUERY, 0.3, [phrase(1, 0.4), phrase(2, 0.7), phrase(3, 0.5)]);
	assert.equal(d.smallTalk, false);
	assert.equal(d.phraseId, 2);
	assert.ok(Math.abs(d.sim - 0.7) < 1e-4);
	assert.equal(decideSmallTalk(QUERY, 0.3, []).sim, -1);
});

test('the kill switch: on by default, off for 0/off/false', () => {
	assert.equal(smallTalkGateEnabled(undefined), true);
	assert.equal(smallTalkGateEnabled(''), true);
	assert.equal(smallTalkGateEnabled('1'), true);
	for (const off of ['0', 'off', 'OFF', 'false', ' False ']) assert.equal(smallTalkGateEnabled(off), false, off);
});

test('isGateCalibratedFor: bge-m3 spellings from every server are accepted', () => {
	for (const m of ['bge-m3', 'bge-m3:latest', 'bge-m3:567m', 'bge-m3-Q8_0.gguf', 'BAAI/bge-m3', 'gpustack/bge-m3-GGUF', String.raw`C:\models\bge-m3-f16.gguf`, 'hf.co/gpustack/bge-m3-GGUF:Q8_0']) {
		assert.equal(isGateCalibratedFor(m, 1024), true, m);
	}
});

test('isGateCalibratedFor: other models, rerankers and wrong dims are rejected', () => {
	for (const m of ['bge-large', 'bge-large-en-v1.5', 'bge-small-en', 'nomic-embed-text', 'qwen3-embedding:0.6b', 'bge-reranker-v2-m3', 'bge-m3-reranker', 'bge-m3x', 'text-embedding-3-small', '']) {
		assert.equal(isGateCalibratedFor(m, 1024), false, m);
	}
	assert.equal(isGateCalibratedFor('bge-m3', 768), false);
	assert.equal(isGateCalibratedFor('bge-m3', 0), false);
});
