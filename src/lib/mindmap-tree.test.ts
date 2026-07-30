import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTree, treeToMarkdownOutline } from './mindmap-tree';

test('a simple 2-level chain builds a nested tree', () => {
	const tree = buildTree('Title', [
		{ path: ['A', 'B'], source_path: 'a.md', heading_path: 'A > B' }
	]);
	assert.equal(tree.label, 'Title');
	assert.equal(tree.children.length, 1);
	assert.equal(tree.children[0].label, 'A');
	assert.equal(tree.children[0].sourcePath, null);
	assert.equal(tree.children[0].children.length, 1);
	assert.equal(tree.children[0].children[0].label, 'B');
	assert.equal(tree.children[0].children[0].sourcePath, 'a.md');
});

test('two nodes sharing a prefix are merged, not duplicated', () => {
	const tree = buildTree('Title', [
		{ path: ['A', 'B'], source_path: 'a.md', heading_path: 'A > B' },
		{ path: ['A', 'C'], source_path: 'c.md', heading_path: 'A > C' }
	]);
	assert.equal(tree.children.length, 1);
	assert.equal(tree.children[0].label, 'A');
	assert.equal(tree.children[0].children.length, 2);
	assert.deepEqual(
		tree.children[0].children.map((c) => c.label).sort(),
		['B', 'C']
	);
});

test('a node whose ancestors were never separately emitted gets them synthesized', () => {
	const tree = buildTree('Title', [
		{ path: ['A', 'B', 'C'], source_path: 'c.md', heading_path: 'A > B > C' }
	]);
	assert.equal(tree.children.length, 1);
	const a = tree.children[0];
	assert.equal(a.label, 'A');
	assert.equal(a.sourcePath, null); // synthesized, never cited directly
	assert.equal(a.children.length, 1);
	const b = a.children[0];
	assert.equal(b.label, 'B');
	assert.equal(b.sourcePath, null); // synthesized
	assert.equal(b.children.length, 1);
	assert.equal(b.children[0].label, 'C');
	assert.equal(b.children[0].sourcePath, 'c.md');
});

test('an empty nodes array yields a childless root', () => {
	const tree = buildTree('Title', []);
	assert.equal(tree.label, 'Title');
	assert.equal(tree.children.length, 0);
	assert.equal(treeToMarkdownOutline(tree), '');
});

test('treeToMarkdownOutline emits nested bullets indented by depth', () => {
	const tree = buildTree('Title', [
		{ path: ['A', 'B'], source_path: 'b.md', heading_path: 'A > B' },
		{ path: ['D'], source_path: 'd.md', heading_path: 'D' }
	]);
	const outline = treeToMarkdownOutline(tree);
	assert.equal(outline, '- A\n  - B\n- D');
});
