import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reciprocalRankFusion } from './fusion';

test('an item ranked in both lists beats one that only appears in one list', () => {
	// 'a' is rank 2 in list1 and rank 1 in list2 (appears in both).
	// 'x' is rank 1 in list1 only.
	const result = reciprocalRankFusion([
		['x', 'a'],
		['a', 'y']
	]);
	const ids = result.map((r) => r.id);
	assert.ok(ids.indexOf('a') < ids.indexOf('x'), `expected 'a' before 'x', got ${JSON.stringify(ids)}`);
});

test('scores follow the RRF formula: sum of weight / (k + rank) per list', () => {
	const result = reciprocalRankFusion([['a', 'b'], ['a']], { k: 60 });
	const byId = new Map(result.map((r) => [r.id, r.score]));
	// a: rank1 in both lists => 1/61 + 1/61
	assert.ok(Math.abs(byId.get('a')! - (1 / 61 + 1 / 61)) < 1e-12);
	// b: rank2 in list1 only => 1/62
	assert.ok(Math.abs(byId.get('b')! - 1 / 62) < 1e-12);
});

test('weights scale each list\'s contribution', () => {
	// Without weights, 'a' (top of list1) and 'b' (top of list2) tie.
	const unweighted = reciprocalRankFusion([['a'], ['b']], { k: 60 });
	assert.equal(unweighted[0].score, unweighted[1].score);

	// Weighting list2 higher should push 'b' above 'a'.
	const weighted = reciprocalRankFusion([['a'], ['b']], { k: 60, weights: [1, 2] });
	assert.equal(weighted[0].id, 'b');
	assert.ok(weighted[0].score > weighted[1].score);
});

test('throws when weights length does not match the number of lists', () => {
	assert.throws(() => reciprocalRankFusion([['a'], ['b']], { weights: [1] }), /weights length/);
});

test('empty lists are handled without error', () => {
	assert.deepEqual(reciprocalRankFusion([]), []);
	assert.deepEqual(reciprocalRankFusion([[], []]), []);
	const result = reciprocalRankFusion([[], ['a']]);
	assert.deepEqual(result.map((r) => r.id), ['a']);
});

test('deterministic tie-break: equal score falls back to earliest best rank, then id', () => {
	// Construct an exact score tie via weights, with different best ranks:
	// list1 = ['z', 'a'] weight 62 -> a at rank 2: score = 62/(60+2) = 1.0
	// list2 = ['b']      weight 61 -> b at rank 1: score = 61/(60+1) = 1.0
	const result = reciprocalRankFusion([['z', 'a'], ['b']], { k: 60, weights: [62, 61] });
	const a = result.find((r) => r.id === 'a')!;
	const b = result.find((r) => r.id === 'b')!;
	assert.ok(Math.abs(a.score - b.score) < 1e-12, 'expected a and b scores to tie');
	// b's best rank (1) is earlier than a's best rank (2), so b must sort first.
	const ids = result.map((r) => r.id);
	assert.ok(ids.indexOf('b') < ids.indexOf('a'), `expected 'b' before 'a', got ${JSON.stringify(ids)}`);
});

test('deterministic tie-break falls through to id when best ranks also tie', () => {
	// Two singleton lists, both rank 1, equal weight -> exact tie, same best rank (1).
	const result = reciprocalRankFusion([['q'], ['p']], { k: 60 });
	assert.deepEqual(result.map((r) => r.id), ['p', 'q']);
});

test('results are sorted by score descending', () => {
	const result = reciprocalRankFusion([['a', 'b', 'c']]);
	const scores = result.map((r) => r.score);
	for (let i = 1; i < scores.length; i++) assert.ok(scores[i - 1] >= scores[i]);
});
