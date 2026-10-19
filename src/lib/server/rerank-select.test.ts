import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickRerankCandidates, rerankPassage, selectReranked, RERANK_MIN_SCORE } from './rerank-select';
import type { CandidateChunk } from './select-chunks';

function cand(path: string, n: number, over: Partial<CandidateChunk> = {}): CandidateChunk {
	return {
		path,
		heading_path: `H${n}`,
		display_text: `text ${path} ${n}`,
		topic: path,
		depth: 'undergrad',
		domains: ['databases'],
		distance: 0.3 + n / 100,
		...over
	};
}

test('rerankPassage matches the indexer embed string', () => {
	assert.equal(rerankPassage(cand('a.md', 1)), '[a.md | H1] text a.md 1');
});

test('pickRerankCandidates applies hidden-folder, scope, domain and level filters before taking the first N', () => {
	const pool = [
		cand('cards/x.md', 1),
		cand('wiki/a.md', 2),
		cand('other/b.md', 3),
		cand('wiki/c.md', 4, { domains: ['physics'] }),
		cand('wiki/d.md', 5, { depth: 'phd' }),
		cand('wiki/e.md', 6)
	];
	const picked = pickRerankCandidates(pool, {
		excludedPrefixes: ['cards'],
		includedPaths: ['wiki'],
		domains: ['Databases'],
		levels: ['undergraduate']
	});
	assert.deepEqual(picked.map((c) => c.path), ['wiki/a.md', 'wiki/e.md']);
	assert.deepEqual(pickRerankCandidates(pool, {}, 2).map((c) => c.path), ['cards/x.md', 'wiki/a.md']);
});

test('pickRerankCandidates ignores the distance entirely', () => {
	assert.equal(pickRerankCandidates([cand('a.md', 1, { distance: 0.99 })], {}).length, 1);
});

test('a best score under the threshold is a no-match with no chunks', () => {
	const r = selectReranked([cand('a.md', 1), cand('b.md', 2)], [0.019, 0.001], { k: 6 });
	assert.equal(r.noMatch, true);
	assert.deepEqual(r.chunks, []);
	assert.equal(r.best, 0.019);
});

test('no candidates is a no-match', () => {
	assert.deepEqual(selectReranked([], [], { k: 6 }), { best: 0, noMatch: true, chunks: [] });
});

test('chunks are sorted by score, those under the threshold are dropped, scores are attached', () => {
	const r = selectReranked([cand('a.md', 1), cand('b.md', 2), cand('c.md', 3)], [0.1, 0.9, 0.01], { k: 6 });
	assert.equal(r.noMatch, false);
	assert.deepEqual(r.chunks.map((c) => [c.path, c.rerankScore]), [['b.md', 0.9], ['a.md', 0.1]]);
	assert.equal(r.best, 0.9);
});

test('the threshold is inclusive and equal scores keep the vector order', () => {
	const r = selectReranked([cand('a.md', 1), cand('b.md', 2)], [RERANK_MIN_SCORE, RERANK_MIN_SCORE], { k: 6 });
	assert.deepEqual(r.chunks.map((c) => c.path), ['a.md', 'b.md']);
});

test('at most 3 chunks per file and k overall', () => {
	const pool = [1, 2, 3, 4, 5].map((n) => cand('a.md', n)).concat([cand('b.md', 6), cand('c.md', 7)]);
	const scores = [0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3];
	assert.deepEqual(selectReranked(pool, scores, { k: 4 }).chunks.map((c) => c.path), ['a.md', 'a.md', 'a.md', 'b.md']);
	assert.equal(selectReranked(pool, scores, { k: 10 }).chunks.length, 5);
});

test('a missing or non-finite score counts as 0', () => {
	const r = selectReranked([cand('a.md', 1), cand('b.md', 2)], [Number.NaN], { k: 6 });
	assert.equal(r.noMatch, true);
});
