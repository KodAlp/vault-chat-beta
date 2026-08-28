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
	// A was synthesized, but inherits B's citation so it is clickable too.
	assert.equal(tree.children[0].sourcePath, 'a.md');
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
	assert.equal(a.children.length, 1);
	const b = a.children[0];
	assert.equal(b.label, 'B');
	assert.equal(b.children.length, 1);
	assert.equal(b.children[0].label, 'C');
	assert.equal(b.children[0].sourcePath, 'c.md');
	// Synthesized ancestors inherit the only citation below them, so no node
	// in a rendered map is ever left unclickable.
	assert.equal(a.sourcePath, 'c.md');
	assert.equal(a.headingPath, 'A > B > C');
	assert.equal(b.sourcePath, 'c.md');
});

test('a branch inherits its FIRST cited descendant, not the last', () => {
	const tree = buildTree('Title', [
		{ path: ['A', 'B'], source_path: 'b.md', heading_path: 'A > B' },
		{ path: ['A', 'C'], source_path: 'c.md', heading_path: 'A > C' }
	]);
	assert.equal(tree.children[0].sourcePath, 'b.md');
});

test('a node that cites something itself keeps its own citation', () => {
	const tree = buildTree('Title', [
		{ path: ['A'], source_path: 'a.md', heading_path: 'A' },
		{ path: ['A', 'B'], source_path: 'b.md', heading_path: 'A > B' }
	]);
	assert.equal(tree.children[0].sourcePath, 'a.md');
	assert.equal(tree.children[0].children[0].sourcePath, 'b.md');
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

test('treeToMarkdownOutline with no linkFor stays plain text (default, unchanged)', () => {
	const tree = buildTree('Title', [{ path: ['A'], source_path: 'a.md', heading_path: 'A' }]);
	assert.equal(treeToMarkdownOutline(tree), '- A');
});

test('treeToMarkdownOutline links only nodes linkFor returns a url for', () => {
	const tree = buildTree('Title', [
		{ path: ['A', 'B'], source_path: 'b.md', heading_path: 'A > B' }
	]);
	// A is synthesized but now inherits B's citation, so both are linked —
	// that is the whole point of backfillCitations. linkFor still gets the
	// final say by returning null, which the extra assertion below covers.
	const outline = treeToMarkdownOutline(tree, (node) =>
		node.sourcePath ? `/library/view?path=${node.sourcePath}` : null
	);
	assert.equal(
		outline,
		'- [A](/library/view?path=b.md)\n  - [B](/library/view?path=b.md)'
	);
	// A linkFor that vetoes everything still yields plain text.
	assert.equal(treeToMarkdownOutline(tree, () => null), '- A\n  - B');
});

test('treeToMarkdownOutline escapes literal "[" and "]" in a linked label', () => {
	const tree = buildTree('Title', [
		{ path: ['Diziler [Bölüm 3]'], source_path: 'x.md', heading_path: 'Diziler' }
	]);
	const outline = treeToMarkdownOutline(tree, () => '/library/view?path=x.md');
	assert.equal(outline, '- [Diziler \\[Bölüm 3\\]](/library/view?path=x.md)');
});
