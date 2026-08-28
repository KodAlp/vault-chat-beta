import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyDisplayRules, collectFilePaths, nodeState, toggleNode, toIncludedPaths } from './sourceTree';
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

const displayTree: LibraryNode[] = [
	{ name: 'cards', path: 'cards', type: 'folder', children: [{ name: 'math.md', path: 'cards/math.md', type: 'file' }] },
	{
		name: 'wiki',
		path: 'wiki',
		type: 'folder',
		children: [
			{ name: '_index', path: 'wiki/_index', type: 'folder', children: [] },
			{ name: 'math', path: 'wiki/math', type: 'folder', children: [] },
			{ name: 'dsa', path: 'wiki/dsa', type: 'folder', children: [] }
		]
	},
	{ name: 'notes.md', path: 'notes.md', type: 'file' }
];

test('applyDisplayRules drops hidden root folders entirely', () => {
	const out = applyDisplayRules(displayTree, { hiddenFolders: ['cards'], flattenFolders: [] });
	assert.deepEqual(out.map((n) => n.name), ['wiki', 'notes.md']);
});

test('applyDisplayRules replaces a flattened root folder with its children, paths untouched', () => {
	const out = applyDisplayRules(displayTree, { hiddenFolders: [], flattenFolders: ['wiki'] });
	assert.deepEqual(out.map((n) => n.name), ['cards', '_index', 'math', 'dsa', 'notes.md']);
	const math = out.find((n) => n.name === 'math');
	assert.equal(math?.path, 'wiki/math'); // the child's own path is unchanged — only the tree shape moved
});

test('applyDisplayRules combines hiding and flattening, leaves files and unlisted folders alone', () => {
	const out = applyDisplayRules(displayTree, { hiddenFolders: ['cards'], flattenFolders: ['wiki'] });
	assert.deepEqual(out.map((n) => n.name), ['_index', 'math', 'dsa', 'notes.md']);
});

test('applyDisplayRules is a no-op when both rule lists are empty', () => {
	const out = applyDisplayRules(displayTree, { hiddenFolders: [], flattenFolders: [] });
	assert.deepEqual(out.map((n) => n.name), ['cards', 'wiki', 'notes.md']);
});

// Regression: flattening used to splice a folder's children into the root
// without ever offering them to the hidden check, so a nested bookkeeping
// folder (wiki/_index — the MOC layer) was unreachable by hiddenFolders no
// matter what it contained.
test('applyDisplayRules hides children of a flattened folder too', () => {
	const out = applyDisplayRules(displayTree, {
		hiddenFolders: ['wiki/_index'],
		flattenFolders: ['wiki']
	});
	assert.deepEqual(out.map((n) => n.name), ['cards', 'math', 'dsa', 'notes.md']);
});

test('applyDisplayRules matches hiddenFolders as path prefixes, not just names', () => {
	// "wiki" alone hides the whole subtree; a bare root name still works too.
	assert.deepEqual(
		applyDisplayRules(displayTree, { hiddenFolders: ['wiki'], flattenFolders: [] }).map((n) => n.name),
		['cards', 'notes.md']
	);
	// A name that is NOT a real path prefix must not match anything.
	assert.deepEqual(
		applyDisplayRules(displayTree, { hiddenFolders: ['_index'], flattenFolders: ['wiki'] }).map((n) => n.name),
		['cards', '_index', 'math', 'dsa', 'notes.md']
	);
});

test('applyDisplayRules applies the shipped defaults to a real vault root', () => {
	const out = applyDisplayRules(displayTree, {
		hiddenFolders: ['raw', 'cards', 'frontier', 'notes', 'wiki/_index'],
		flattenFolders: ['wiki']
	});
	assert.deepEqual(out.map((n) => n.name), ['math', 'dsa', 'notes.md']);
});
