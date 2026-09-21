import { test } from 'node:test';
import assert from 'node:assert/strict';
import matter from 'gray-matter';
import {
	buildSlugIndex,
	findCycles,
	parsePrerequisites,
	resolvePrerequisites,
	slugKey,
	slugOfPath,
	transitivePrerequisites
} from './prerequisites';

test('wikilinks in a quoted YAML list become their target names, in order', () => {
	const { data } = matter("---\ntitle: x\nprerequisites:\n  - '[[online-algorithms]]'\n  - '[[np-completeness]]'\n---\nbody");
	assert.deepEqual(parsePrerequisites(data.prerequisites), ['online-algorithms', 'np-completeness']);
});

test('an UNQUOTED wikilink is arrays inside arrays in YAML and must still work', () => {
	const { data } = matter('---\ntitle: x\nprerequisites:\n  - [[online-algorithms]]\n  - [[np-completeness]]\n---\nbody');
	// `[[x]]` is a flow sequence holding a flow sequence, so each list item is two levels deep
	assert.deepEqual(data.prerequisites, [[['online-algorithms']], [['np-completeness']]], 'the YAML really does nest it');
	assert.deepEqual(parsePrerequisites(data.prerequisites), ['online-algorithms', 'np-completeness']);
});

test('alias, heading, folder and .md suffix are all stripped to the note name', () => {
	assert.deepEqual(
		parsePrerequisites(['[[Big-O Notation|big o]]', '[[np-completeness#Reductions]]', '[[wiki/algorithms/heaps]]', '[[graphs.md]]']),
		['Big-O Notation', 'np-completeness', 'heaps', 'graphs']
	);
});

test('a bare string and a comma list are accepted; several links in one string are all taken', () => {
	assert.deepEqual(parsePrerequisites('graphs'), ['graphs']);
	assert.deepEqual(parsePrerequisites('graphs, heaps'), ['graphs', 'heaps']);
	assert.deepEqual(parsePrerequisites('[[a]] and [[b]]'), ['a', 'b']);
});

test('empty, missing and malformed values give an empty list instead of throwing', () => {
	for (const v of [undefined, null, [], '', '   ', 42, true, {}, [null, 3, {}], [[]]]) assert.deepEqual(parsePrerequisites(v), [], JSON.stringify(v));
});

test('duplicates are dropped case-insensitively, keeping the first spelling', () => {
	assert.deepEqual(parsePrerequisites(['[[Heaps]]', '[[heaps]]', '[[HEAPS|h]]']), ['Heaps']);
});

test('slugKey and slugOfPath fold case and Unicode form the way link resolution does', () => {
	assert.equal(slugKey('  NP-Completeness '), 'np-completeness');
	assert.equal(slugOfPath('wiki/algorithms/NP-Completeness.md'), 'np-completeness');
	assert.equal(slugKey('şeker'), slugKey('şeker'.normalize('NFC').replace('ş', 'ş')));
});

test('resolvePrerequisites separates resolved, unresolved and ambiguous names', () => {
	const index = buildSlugIndex(['wiki/a/heaps.md', 'wiki/b/graphs.md', 'wiki/c/sorting.md', 'wiki/d/sorting.md']);
	assert.deepEqual(resolvePrerequisites(['Heaps', 'graphs', 'missing', 'sorting'], index), {
		resolved: ['wiki/a/heaps.md', 'wiki/b/graphs.md'],
		unresolved: ['missing'],
		ambiguous: ['sorting']
	});
});

test('findCycles: none in a DAG, one loop found and reported', () => {
	const dag = new Map([['a', ['b', 'c']], ['b', ['c']], ['c', []]]);
	assert.deepEqual(findCycles(dag), []);
	const loop = new Map([['a', ['b']], ['b', ['c']], ['c', ['a']], ['d', ['a']]]);
	const cycles = findCycles(loop);
	assert.equal(cycles.length, 1);
	assert.deepEqual([...cycles[0]].sort(), ['a', 'b', 'c']);
});

test('findCycles sees a self-loop and a cycle that is only reached through another node', () => {
	assert.equal(findCycles(new Map([['a', ['a']]])).length, 1);
	assert.equal(findCycles(new Map([['x', ['y']], ['y', ['z']], ['z', ['y']]])).length, 1);
});

test('transitivePrerequisites is nearest-first, without repeats, without the note itself, and survives a cycle', () => {
	const g = new Map([['a', ['b', 'c']], ['b', ['d']], ['c', ['d']], ['d', []]]);
	assert.deepEqual(transitivePrerequisites('a', g), ['b', 'c', 'd']);
	const loop = new Map([['a', ['b']], ['b', ['a']]]);
	assert.deepEqual(transitivePrerequisites('a', loop), ['b']);
	assert.deepEqual(transitivePrerequisites('unknown', g), []);
});
