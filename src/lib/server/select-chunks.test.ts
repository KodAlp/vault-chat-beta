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

test('with no includedPaths, out-of-domain results never set narrowScope', () => {
	const candidates = [candidate({ domains: ['electronics'] })];
	const result = selectChunks(candidates, { domains: ['math'] });
	assert.deepEqual(result.chunks, []);
	assert.equal(result.narrowScope, false);
});
