import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isHiddenPath, buildQueryMessages, queryForItem, percentile, fuseCandidates, mergeCandidateMap, anchorIds, type CandidateChunk } from './pipelines';
import { chunkAnchor } from './anchor';

// --- isHiddenPath -----------------------------------------------------------

test('isHiddenPath: exact prefix match is hidden', () => {
	assert.equal(isHiddenPath('raw', ['raw', 'cards']), true);
});

test('isHiddenPath: subpath of a hidden prefix is hidden', () => {
	assert.equal(isHiddenPath('raw/foo/bar.md', ['raw', 'cards']), true);
});

test('isHiddenPath: a path that merely starts with the same letters is NOT hidden', () => {
	// 'raw-notes' must not match the 'raw' prefix rule (exact-or-subpath only).
	assert.equal(isHiddenPath('raw-notes/x.md', ['raw']), false);
});

test('isHiddenPath: a visible path with no matching prefix is not hidden', () => {
	assert.equal(isHiddenPath('wiki/algorithms/sorting.md', ['raw', 'cards', 'frontier']), false);
});

test('isHiddenPath: empty prefix list hides nothing', () => {
	assert.equal(isHiddenPath('raw/anything.md', []), false);
});

// --- buildQueryMessages / queryForItem ---------------------------------------

test('buildQueryMessages: a plain question with no turns becomes a single user message', () => {
	const messages = buildQueryMessages({ question: 'What is a B-tree?' });
	assert.equal(messages.length, 1);
	assert.equal(messages[0].role, 'user');
	assert.equal(messages[0].content, 'What is a B-tree?');
});

test('buildQueryMessages: prior turns are prepended in order, the question is always last', () => {
	const messages = buildQueryMessages({
		question: 'why?',
		turns: [
			{ role: 'user', content: 'Explain paging.' },
			{ role: 'assistant', content: 'Paging splits memory into fixed-size pages...' }
		]
	});
	assert.deepEqual(
		messages.map((m) => [m.role, m.content]),
		[
			['user', 'Explain paging.'],
			['assistant', 'Paging splits memory into fixed-size pages...'],
			['user', 'why?']
		]
	);
});

test('queryForItem: a single-turn item is just the question', () => {
	assert.equal(queryForItem({ question: 'What is a bloom filter?' }), 'What is a bloom filter?');
});

test('queryForItem: a follow-up carries the prior user turn (retrieval-query.ts behavior)', () => {
	const q = queryForItem({
		question: 'neden?',
		turns: [
			{ role: 'user', content: 'Turev nedir' },
			{ role: 'assistant', content: 'Turev bir fonksiyonun anlik degisim oranidir.' }
		]
	});
	// buildRetrievalQuery puts the last user message last and prepends the
	// nearest earlier user turn that still fits the character budget.
	assert.ok(q.endsWith('neden?'));
	assert.ok(q.includes('Turev nedir'));
});

// --- percentile ---------------------------------------------------------------

test('percentile: p50 of an odd-length array is the middle value', () => {
	assert.equal(percentile([1, 2, 3, 4, 5], 50), 3);
});

test('percentile: p0 and p100 are min and max', () => {
	const values = [5, 1, 4, 2, 3];
	assert.equal(percentile(values, 0), 1);
	assert.equal(percentile(values, 100), 5);
});

test('percentile: interpolates between ranks for an even-length array', () => {
	assert.equal(percentile([1, 2, 3, 4], 50), 2.5);
});

test('percentile: single value returns itself regardless of p', () => {
	assert.equal(percentile([7], 0), 7);
	assert.equal(percentile([7], 99), 7);
});

test('percentile: empty input returns NaN, not a throw', () => {
	assert.ok(Number.isNaN(percentile([], 50)));
});

test('percentile: does not mutate the input array', () => {
	const values = [3, 1, 2];
	percentile(values, 50);
	assert.deepEqual(values, [3, 1, 2]);
});

// --- RRF candidate merge -> anchors -------------------------------------------

function chunk(path: string, heading: string, text: string, extra: Partial<CandidateChunk> = {}): CandidateChunk {
	return { path, heading_path: heading, display_text: text, topic: 'T', depth: 'undergrad', domains: [], ...extra };
}

test('mergeCandidateMap: first occurrence wins, keyed by content anchor', () => {
	const a = chunk('wiki/a.md', 'A > 1', 'hello world');
	const aDup = chunk('wiki/a.md', 'A > 1', 'hello world'); // same anchor, different object identity
	const b = chunk('wiki/b.md', 'B > 1', 'goodbye world');
	const map = mergeCandidateMap([[a], [aDup, b]]);
	assert.equal(map.size, 2);
	assert.equal(map.get(chunkAnchor(a)), a); // first occurrence, not aDup
});

test('anchorIds: preserves list order', () => {
	const a = chunk('wiki/a.md', 'A', 'x');
	const b = chunk('wiki/b.md', 'B', 'y');
	assert.deepEqual(anchorIds([a, b]), [chunkAnchor(a), chunkAnchor(b)]);
});

test('fuseCandidates: an item ranked in both lists outranks one ranked in only one', () => {
	const shared = chunk('wiki/shared.md', 'Shared', 'appears in both lists');
	const vectorOnly = chunk('wiki/vec.md', 'Vector only', 'top of the vector list only');
	const bm25Only = chunk('wiki/bm25.md', 'Bm25 only', 'top of the bm25 list only');

	// vector list: [vectorOnly, shared]; bm25 list: [shared, bm25Only]
	const fused = fuseCandidates([[vectorOnly, shared], [shared, bm25Only]], 10);
	const anchors = fused.map((f) => chunkAnchor(f.candidate));
	assert.equal(anchors[0], chunkAnchor(shared), `expected the doubly-ranked item first, got ${JSON.stringify(anchors)}`);
});

test('fuseCandidates: resolves fused ids back to full candidate objects (path/heading/topic intact)', () => {
	const c = chunk('wiki/x.md', 'X > Y', 'body text', { topic: 'Some Topic', depth: 'grad', domains: ['math'] });
	const fused = fuseCandidates([[c]], 10);
	assert.equal(fused.length, 1);
	assert.deepEqual(fused[0].candidate, c);
});

test('fuseCandidates: truncates to topN', () => {
	const candidates = Array.from({ length: 5 }, (_, i) => chunk(`wiki/${i}.md`, `H${i}`, `text ${i}`));
	const fused = fuseCandidates([candidates], 2);
	assert.equal(fused.length, 2);
});

test('fuseCandidates: an id present in one list but unresolvable in the map is simply skipped', () => {
	// Two lists that share no anchors at all still produce a valid fused ranking
	// covering every distinct item, since mergeCandidateMap covers every list.
	const a = chunk('wiki/a.md', 'A', 'aaa');
	const b = chunk('wiki/b.md', 'B', 'bbb');
	const fused = fuseCandidates([[a], [b]], 10);
	assert.equal(fused.length, 2);
});
