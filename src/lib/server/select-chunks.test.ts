import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectChunks, type CandidateChunk } from './select-chunks';

function candidate(overrides: Partial<CandidateChunk> = {}): CandidateChunk {
	return {
		path: 'wiki/math/calculus.md',
		heading_path: 'Türev',
		display_text: 'içerik',
		topic: 'Türev',
		depth: 'undergrad',
		domains: ['math'],
		distance: 0.2,
		...overrides
	};
}

test('drops matches above the distance threshold', () => {
	const result = selectChunks([candidate({ distance: 0.9 })]);
	assert.deepEqual(result.chunks, []);
	assert.equal(result.narrowScope, false);
});

test('filters by domain when domains is provided', () => {
	const inDomain = candidate({ path: 'a.md', domains: ['math'] });
	const outOfDomain = candidate({ path: 'b.md', domains: ['electronics'] });
	const result = selectChunks([inDomain, outOfDomain], { domains: ['math'] });
	assert.equal(result.chunks.length, 1);
	assert.equal(result.chunks[0].path, 'a.md');
});

// Ö7 (2026-09-23 report): search_library's domain filter was the only one
// of the two MCP filters that was case-sensitive — the same domain string
// returned 8 real matches from list_sources (SQL `lower(d.value) =
// lower(?)`) and 0 from search_library, for the same vault.
test('domain filter is case-insensitive, matching list_sources', () => {
	const candidates = [candidate({ path: 'a.md', domains: ['Databases'] })];
	const result = selectChunks(candidates, { domains: ['databases'] });
	assert.equal(result.chunks.length, 1);
});

test('caps chunks per file at 3', () => {
	const candidates = Array.from({ length: 5 }, (_, i) =>
		candidate({ path: 'same.md', heading_path: `h${i}`, distance: 0.1 + i * 0.01 })
	);
	const result = selectChunks(candidates, { k: 10 });
	assert.equal(result.chunks.length, 3);
});

test('respects the k limit', () => {
	const candidates = Array.from({ length: 5 }, (_, i) =>
		candidate({ path: `f${i}.md`, distance: 0.1 + i * 0.01 })
	);
	const result = selectChunks(candidates, { k: 2 });
	assert.equal(result.chunks.length, 2);
});

test('includedPaths keeps exact matches and subpaths, excludes siblings', () => {
	const candidates = [
		candidate({ path: 'wiki/math/calculus.md' }),
		candidate({ path: 'wiki/math/calculus/part-1.md' }),
		candidate({ path: 'wiki/math-other/note.md' }),
		candidate({ path: 'wiki/physics/note.md' })
	];
	const result = selectChunks(candidates, { includedPaths: ['wiki/math'] });
	const paths = result.chunks.map((c) => c.path);
	assert.deepEqual(paths, ['wiki/math/calculus.md', 'wiki/math/calculus/part-1.md']);
});

test('narrowScope is true when in-threshold matches exist but all fall outside includedPaths', () => {
	const candidates = [candidate({ path: 'wiki/physics/note.md', distance: 0.1 })];
	const result = selectChunks(candidates, { includedPaths: ['wiki/math'] });
	assert.deepEqual(result.chunks, []);
	assert.equal(result.narrowScope, true);
});

test('narrowScope is false when the vault has nothing relevant at all (not a scope problem)', () => {
	const candidates = [candidate({ distance: 0.9 })];
	const result = selectChunks(candidates, { includedPaths: ['wiki/math'] });
	assert.deepEqual(result.chunks, []);
	assert.equal(result.narrowScope, false);
});

test('narrowScope is false when includedPaths is omitted, even with zero results', () => {
	const result = selectChunks([candidate({ distance: 0.9 })]);
	assert.equal(result.narrowScope, false);
});

test('an explicitly empty includedPaths scopes to nothing, unlike an omitted one', () => {
	const result = selectChunks([candidate({ distance: 0.1 })], { includedPaths: [] });
	assert.deepEqual(result.chunks, []);
	assert.equal(result.narrowScope, true);
});

test('with no includedPaths, out-of-domain results never set narrowScope', () => {
	const candidates = [candidate({ domains: ['electronics'] })];
	const result = selectChunks(candidates, { domains: ['math'] });
	assert.deepEqual(result.chunks, []);
	assert.equal(result.narrowScope, false);
});

test('filters by level when levels is provided', () => {
	const undergrad = candidate({ path: 'a.md', depth: 'undergrad' });
	const grad = candidate({ path: 'b.md', depth: 'grad' });
	const result = selectChunks([undergrad, grad], { levels: ['grad'] });
	assert.equal(result.chunks.length, 1);
	assert.equal(result.chunks[0].path, 'b.md');
});

test('level filter is case-insensitive (frontmatter is hand-written, not an enum)', () => {
	const candidates = [candidate({ path: 'a.md', depth: 'Undergrad' })];
	const result = selectChunks(candidates, { levels: ['UNDERGRAD'] });
	assert.equal(result.chunks.length, 1);
});

// Ö7 (2026-09-23 report): an index built before normalizeLevel existed could
// still store the un-folded synonym ("undergraduate") in files.depth. A
// query for the canonical spelling ("undergrad") — which is what a caller
// would reasonably type, since that is what normalizeLevel folds every new
// write to — used to miss it entirely.
test('level filter folds synonyms on the stored side, not just the query side', () => {
	const candidates = [candidate({ path: 'a.md', depth: 'undergraduate' })]; // pre-normalizeLevel index
	const result = selectChunks(candidates, { levels: ['undergrad'] });
	assert.equal(result.chunks.length, 1);
});

test('level filter folds synonyms on the query side too', () => {
	const candidates = [candidate({ path: 'a.md', depth: 'undergrad' })]; // canonical, post-fix index
	const result = selectChunks(candidates, { levels: ['undergraduate'] }); // caller typed the alias
	assert.equal(result.chunks.length, 1);
});

test('a level with no matches drops every candidate', () => {
	const candidates = [candidate({ depth: 'undergrad' })];
	const result = selectChunks(candidates, { levels: ['phd'] });
	assert.deepEqual(result.chunks, []);
});

test('levels omitted means every level passes', () => {
	const candidates = [candidate({ depth: 'undergrad' }), candidate({ path: 'b.md', depth: 'phd' })];
	const result = selectChunks(candidates);
	assert.equal(result.chunks.length, 2);
});

test('excludedPrefixes drops exact and subpath matches unconditionally', () => {
	const candidates = [
		candidate({ path: 'cards/math.md' }),
		candidate({ path: 'frontier/algorithms/note.md' }),
		candidate({ path: 'wiki/math/calculus.md' })
	];
	const result = selectChunks(candidates, { excludedPrefixes: ['cards', 'frontier'] });
	assert.deepEqual(
		result.chunks.map((c) => c.path),
		['wiki/math/calculus.md']
	);
});

test('excludedPrefixes never sets narrowScope — it is not a "kapsamı genişlet?" case', () => {
	const candidates = [candidate({ path: 'cards/math.md', distance: 0.1 })];
	const result = selectChunks(candidates, { excludedPrefixes: ['cards'] });
	assert.deepEqual(result.chunks, []);
	assert.equal(result.narrowScope, false);
});

test('excludedPrefixes applies even when includedPaths would otherwise allow the file', () => {
	const candidates = [candidate({ path: 'cards/math.md', distance: 0.1 })];
	const result = selectChunks(candidates, {
		includedPaths: ['cards'],
		excludedPrefixes: ['cards']
	});
	assert.deepEqual(result.chunks, []);
});

test('a keyword-sourced chunk skips the distance threshold (its distance is a placeholder)', () => {
	const result = selectChunks([candidate({ distance: 1, via: 'keyword' })]);
	assert.equal(result.chunks.length, 1);
	assert.equal(result.chunks[0].via, 'keyword');
});

test('a vector chunk with the same placeholder distance is still dropped', () => {
	assert.deepEqual(selectChunks([candidate({ distance: 1 })]).chunks, []);
});

test('keyword chunks are still subject to hidden folders, scope, domain and the per-file cap', () => {
	const kw = (o: Partial<CandidateChunk>) => candidate({ distance: 1, via: 'keyword', ...o });
	const hidden = selectChunks([kw({ path: 'cards/a.md' })], { excludedPrefixes: ['cards'] });
	assert.deepEqual(hidden.chunks, []);
	const outOfScope = selectChunks([kw({ path: 'wiki/x.md' })], { includedPaths: ['wiki/y'] });
	assert.deepEqual(outOfScope.chunks, []);
	assert.equal(outOfScope.narrowScope, true);
	const wrongDomain = selectChunks([kw({ domains: ['electronics'] })], { domains: ['math'] });
	assert.deepEqual(wrongDomain.chunks, []);
	const capped = selectChunks(Array.from({ length: 5 }, (_, i) => kw({ path: 'same.md', heading_path: `h${i}` })), { k: 10 });
	assert.equal(capped.chunks.length, 3);
});

test('vector chunks carry no via marker', () => {
	assert.equal('via' in selectChunks([candidate()]).chunks[0], false);
});
