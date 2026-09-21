import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shuffleOptions, shuffleQuestionOptions } from './quiz-options';

/** Deterministic generator (mulberry32), so the statistical test cannot flake. */
function seeded(seed: number) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

test('a shuffle is a permutation: nothing lost, nothing added, the input untouched', () => {
	const input = ['a', 'b', 'c', 'd', 'e'];
	const out = shuffleOptions(input, seeded(1));
	assert.deepEqual([...out].sort(), [...input].sort());
	assert.deepEqual(input, ['a', 'b', 'c', 'd', 'e']);
});

test('the same seed gives the same order, another seed another one', () => {
	const input = ['a', 'b', 'c', 'd', 'e'];
	assert.deepEqual(shuffleOptions(input, seeded(7)), shuffleOptions(input, seeded(7)));
	assert.notDeepEqual(shuffleOptions(input, seeded(7)), shuffleOptions(input, seeded(8)));
});

test('a correct option that always started in slot A ends up spread evenly over A..E (chi-square, df 4, p > 0.01)', () => {
	const rng = seeded(2026);
	const counts = [0, 0, 0, 0, 0];
	const N = 5000;
	for (let i = 0; i < N; i++) counts[shuffleOptions(['RIGHT', 'x', 'y', 'z', 'w'], rng).indexOf('RIGHT')]++;
	const expected = N / 5;
	const chi = counts.reduce((s, c) => s + (c - expected) ** 2 / expected, 0);
	assert.ok(chi < 13.28, `positions ${counts.join('/')} chi-square ${chi.toFixed(1)}`);
});

test('the answer is still exactly one of the shuffled options', () => {
	const r = shuffleQuestionOptions(['bir', 'iki', 'üç', 'dört', 'beş'], 'üç', seeded(3));
	assert.ok(r.options.includes(r.answer));
	assert.equal(r.answer, 'üç');
	assert.equal(r.options.length, 5);
});

test('letter labels on every option are removed before shuffling, from the answer too', () => {
	const r = shuffleQuestionOptions(['A) bir', 'B) iki', 'C) üç', 'D) dört', 'E) beş'], 'C) üç', seeded(4));
	assert.deepEqual([...r.options].sort(), ['bir', 'dört', 'beş', 'iki', 'üç'].sort());
	assert.equal(r.answer, 'üç');
	assert.ok(r.options.includes(r.answer));
});

test('a stray label on only some options is content, not a label scheme: nothing is stripped', () => {
	const opts = ['A) bir', 'iki', 'üç', 'dört', 'beş'];
	const r = shuffleQuestionOptions(opts, 'iki', seeded(5));
	assert.deepEqual([...r.options].sort(), [...opts].sort());
	assert.equal(r.answer, 'iki');
});
