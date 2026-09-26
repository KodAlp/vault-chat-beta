import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	bootstrapCI,
	chunkQrelsToFileQrels,
	dedupeToFiles,
	hitAtK,
	mean,
	ndcgAtK,
	pairedRandomizationTest,
	precisionAtK,
	recallAtK,
	reciprocalRankAtK
} from './metrics';

function closeTo(actual: number, expected: number, eps = 1e-9): void {
	assert.ok(Math.abs(actual - expected) < eps, `expected ${actual} to be within ${eps} of ${expected}`);
}

// Spec worked example: ground truth {chunk_183, chunk_194}, retrieved ranking
// [chunk_183, chunk_221, chunk_194, chunk_087, chunk_032].
test('worked example: Recall@5 = 1, Recall@1 = 0.5, Precision@5 = 0.4, RR = 1', () => {
	const retrieved = ['chunk_183', 'chunk_221', 'chunk_194', 'chunk_087', 'chunk_032'];
	const relevance = new Map([
		['chunk_183', 2],
		['chunk_194', 2]
	]);
	assert.equal(recallAtK(retrieved, relevance, 5), 1);
	assert.equal(recallAtK(retrieved, relevance, 1), 0.5);
	assert.equal(precisionAtK(retrieved, relevance, 5), 0.4);
	assert.equal(reciprocalRankAtK(retrieved, relevance, 5), 1);
	assert.equal(hitAtK(retrieved, relevance, 5), 1);
	assert.equal(hitAtK(retrieved, relevance, 1), 1);
});

test('reciprocal rank is 1/3 when the first relevant item is at rank 3', () => {
	const retrieved = ['chunk_001', 'chunk_002', 'chunk_183', 'chunk_004'];
	const relevance = new Map([['chunk_183', 2]]);
	assert.equal(reciprocalRankAtK(retrieved, relevance, 5), 1 / 3);
	assert.equal(hitAtK(retrieved, relevance, 2), 0);
	assert.equal(hitAtK(retrieved, relevance, 3), 1);
});

// Hand-computed graded nDCG@5 example.
//
// retrieved = [c183, c221, c194, c087, c032], grades: c183 = 2, c194 = 1 (all others 0).
// gain(g, i) = (2^g - 1) / log2(i + 2), i is the 0-indexed rank.
//
// DCG@5:
//   c183 at i=0: (2^2 - 1) / log2(2) = 3 / 1        = 3
//   c194 at i=2: (2^1 - 1) / log2(4) = 1 / 2         = 0.5
//   DCG = 3 + 0.5 = 3.5
//
// IDCG@5 (ideal order sorts grades desc: [2, 1]):
//   i=0, g=2: (2^2 - 1) / log2(2) = 3 / 1            = 3
//   i=1, g=1: (2^1 - 1) / log2(3) = 1 / 1.5849625... ≈ 0.6309297536
//   IDCG ≈ 3.6309297536
//
// nDCG@5 = 3.5 / 3.6309297536 ≈ 0.9639...
test('graded nDCG@5 matches hand-computed arithmetic', () => {
	const retrieved = ['chunk_183', 'chunk_221', 'chunk_194', 'chunk_087', 'chunk_032'];
	const relevance = new Map([
		['chunk_183', 2],
		['chunk_194', 1]
	]);
	const dcg = (Math.pow(2, 2) - 1) / Math.log2(2) + (Math.pow(2, 1) - 1) / Math.log2(4);
	const idcg = (Math.pow(2, 2) - 1) / Math.log2(2) + (Math.pow(2, 1) - 1) / Math.log2(3);
	closeTo(ndcgAtK(retrieved, relevance, 5)!, dcg / idcg);
	closeTo(ndcgAtK(retrieved, relevance, 5)!, 0.9639, 1e-4);
});

test('nDCG truncates the ideal ranking at K too', () => {
	// Three relevant grades but K=1: IDCG should use only the single best grade.
	const relevance = new Map([
		['a', 2],
		['b', 1],
		['c', 1]
	]);
	const retrieved = ['a'];
	// DCG@1 = IDCG@1 (best item retrieved first) => nDCG = 1.
	assert.equal(ndcgAtK(retrieved, relevance, 1), 1);
});

test('empty retrieval: precision is null, recall is 0 (relevant items exist, just none retrieved)', () => {
	const relevance = new Map([['chunk_183', 2]]);
	assert.equal(precisionAtK([], relevance, 5), null);
	assert.equal(recallAtK([], relevance, 5), 0);
	assert.equal(reciprocalRankAtK([], relevance, 5), 0);
	assert.equal(hitAtK([], relevance, 5), 0);
});

test('a query with no relevant items excludes recall and nDCG (null), not zero', () => {
	const relevance = new Map<string, number>();
	const retrieved = ['chunk_001', 'chunk_002'];
	assert.equal(recallAtK(retrieved, relevance, 5), null);
	assert.equal(ndcgAtK(retrieved, relevance, 5), null);
	// Precision and RR are still well-defined (0) even with no ground truth.
	assert.equal(precisionAtK(retrieved, relevance, 5), 0);
	assert.equal(reciprocalRankAtK(retrieved, relevance, 5), 0);
});

test('precision denominator is min(K, retrieved.length)', () => {
	const relevance = new Map([['a', 2]]);
	// Only 2 retrieved but K=5: denominator is 2, not 5.
	assert.equal(precisionAtK(['a', 'b'], relevance, 5), 0.5);
});

test('dedupeToFiles preserves first-occurrence order and drops unresolved ids', () => {
	const paths: Record<string, string> = { c1: 'a.md', c2: 'a.md', c3: 'b.md' };
	const pathOf = (id: string): string | undefined => paths[id];
	const result = dedupeToFiles(['c1', 'c2', 'c3', 'c4', 'c1'], pathOf);
	assert.deepEqual(result, ['a.md', 'b.md']);
});

test('chunkQrelsToFileQrels takes the max grade per path', () => {
	const chunkRelevance = new Map([
		['c1', 1],
		['c2', 2],
		['c3', 2]
	]);
	const paths: Record<string, string> = { c1: 'a.md', c2: 'a.md', c3: 'b.md' };
	const pathOf = (id: string): string | undefined => paths[id];
	const fileRelevance = chunkQrelsToFileQrels(chunkRelevance, pathOf);
	assert.equal(fileRelevance.get('a.md'), 2);
	assert.equal(fileRelevance.get('b.md'), 2);
	assert.equal(fileRelevance.size, 2);
});

test('mean ignores nulls and reports how many were counted', () => {
	assert.deepEqual(mean([1, null, 2, null, 3]), { mean: 2, n: 3 });
	assert.deepEqual(mean([null, null]), { mean: 0, n: 0 });
	assert.deepEqual(mean([]), { mean: 0, n: 0 });
});

test('bootstrapCI is deterministic for a fixed seed and its CI contains the mean', () => {
	const values = [0.1, 0.4, 0.6, 0.8, 1.0, 0.5, 0.3];
	const a = bootstrapCI(values, { seed: 42, iters: 2000 });
	const b = bootstrapCI(values, { seed: 42, iters: 2000 });
	assert.deepEqual(a, b);
	assert.ok(a.lo <= a.mean && a.mean <= a.hi, `expected lo <= mean <= hi, got ${JSON.stringify(a)}`);
});

test('bootstrapCI differs for a different seed (sanity: it is actually using the seed)', () => {
	const values = [0.1, 0.4, 0.6, 0.8, 1.0, 0.5, 0.3];
	const a = bootstrapCI(values, { seed: 1, iters: 2000 });
	const b = bootstrapCI(values, { seed: 2, iters: 2000 });
	assert.notDeepEqual(a, b);
});

test('bootstrapCI on empty input returns NaN rather than throwing', () => {
	const result = bootstrapCI([]);
	assert.ok(Number.isNaN(result.mean));
	assert.ok(Number.isNaN(result.lo));
	assert.ok(Number.isNaN(result.hi));
});

test('pairedRandomizationTest: p is ~1 for identical arrays (no difference to detect)', () => {
	const a = [0.5, 0.6, 0.7, 0.4, 0.5, 0.6, 0.7, 0.4, 0.5, 0.6];
	const p = pairedRandomizationTest(a, a, { seed: 7, iters: 2000 });
	assert.equal(p, 1);
});

test('pairedRandomizationTest: p is small for a clearly shifted pair', () => {
	const a = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1];
	const b = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
	const p = pairedRandomizationTest(a, b, { seed: 7, iters: 5000 });
	assert.ok(p < 0.05, `expected p < 0.05, got ${p}`);
});

test('pairedRandomizationTest throws on mismatched lengths', () => {
	assert.throws(() => pairedRandomizationTest([1, 2], [1]), /same length/);
});

test('pairedRandomizationTest is deterministic for a fixed seed', () => {
	const a = [0.9, 0.2, 0.7, 0.1];
	const b = [0.1, 0.3, 0.2, 0.9];
	const p1 = pairedRandomizationTest(a, b, { seed: 99, iters: 1000 });
	const p2 = pairedRandomizationTest(a, b, { seed: 99, iters: 1000 });
	assert.equal(p1, p2);
});
