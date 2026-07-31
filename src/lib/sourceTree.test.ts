import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectFilePaths, nodeState, toggleNode, toIncludedPaths } from './sourceTree';
import type { LibraryNode } from './types';

const tree: LibraryNode[] = [
	{
		name: 'math',
		path: 'math',
		type: 'folder',
		children: [
			{ name: 'calculus.md', path: 'math/calculus.md', type: 'file' },
			{ name: 'algebra.md', path: 'math/algebra.md', type: 'file' }
		]
	},
	{ name: 'notes.md', path: 'notes.md', type: 'file' }
];

test('collectFilePaths flattens nested folders to leaf files only', () => {
	assert.deepEqual(collectFilePaths(tree).sort(), ['math/algebra.md', 'math/calculus.md', 'notes.md']);
});

test('a file node is checked iff its own path is selected', () => {
	const file = tree[1];
	assert.equal(nodeState(file, new Set(['notes.md'])), 'checked');
	assert.equal(nodeState(file, new Set()), 'unchecked');
});

test('a folder is checked only when every descendant file is selected', () => {
	const folder = tree[0];
	assert.equal(nodeState(folder, new Set(['math/algebra.md', 'math/calculus.md'])), 'checked');
	assert.equal(nodeState(folder, new Set()), 'unchecked');
	assert.equal(nodeState(folder, new Set(['math/algebra.md'])), 'indeterminate');
});

test('an empty folder is unchecked, never indeterminate', () => {
	const empty: LibraryNode = { name: 'empty', path: 'empty', type: 'folder', children: [] };
	assert.equal(nodeState(empty, new Set()), 'unchecked');
});

test('toggling a file flips only that file', () => {
	const file = tree[1];
	const next = toggleNode(file, new Set(['notes.md']));
	assert.equal(next.has('notes.md'), false);
	const next2 = toggleNode(file, new Set());
	assert.equal(next2.has('notes.md'), true);
});

test('toggling a fully-selected folder clears all its descendants', () => {
	const folder = tree[0];
	const next = toggleNode(folder, new Set(['math/algebra.md', 'math/calculus.md', 'notes.md']));
	assert.equal(next.has('math/algebra.md'), false);
	assert.equal(next.has('math/calculus.md'), false);
	assert.equal(next.has('notes.md'), true); // untouched — outside the folder
});

test('toggling an indeterminate folder selects every descendant', () => {
	const folder = tree[0];
	const next = toggleNode(folder, new Set(['math/algebra.md']));
	assert.equal(next.has('math/algebra.md'), true);
	assert.equal(next.has('math/calculus.md'), true);
});

test('toIncludedPaths collapses a full selection to undefined ("all")', () => {
	const all = new Set(collectFilePaths(tree));
	assert.equal(toIncludedPaths(all, collectFilePaths(tree)), undefined);
});

test('toIncludedPaths returns the explicit list for a partial selection', () => {
	const partial = new Set(['notes.md']);
	assert.deepEqual(toIncludedPaths(partial, collectFilePaths(tree)), ['notes.md']);
});

test('toIncludedPaths treats an empty vault (no files) as "all", not a false partial match', () => {
	assert.equal(toIncludedPaths(new Set(), []), undefined);
});
