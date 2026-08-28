import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTree, treeToMarkdownOutline } from './mindmap-tree';

const ROOT = { label: 'Türev', summary: 'Anlık değişim oranı.' };

/** Shorthand for a stored row; summary defaults to empty so tests that do not
 * care about explanations stay readable. */
function row(path: string[], source_path: string, heading_path: string, summary = '') {
	return { path, summary, source_path, heading_path };
}

test('a simple 2-level chain builds a nested tree', () => {
	const tree = buildTree(ROOT, [row(['A', 'B'], 'a.md', 'A > B')]);
	assert.equal(tree.label, 'Türev');
	assert.equal(tree.summary, 'Anlık değişim oranı.');
	assert.equal(tree.children.length, 1);
	assert.equal(tree.children[0].label, 'A');
	// A was synthesized, but inherits B's citation so it is clickable too.
	assert.equal(tree.children[0].sourcePath, 'a.md');
	assert.equal(tree.children[0].children[0].label, 'B');
	assert.equal(tree.children[0].children[0].sourcePath, 'a.md');
});

test('two nodes sharing a prefix are merged, not duplicated', () => {
	const tree = buildTree(ROOT, [
		row(['A', 'B'], 'a.md', 'A > B'),
		row(['A', 'C'], 'c.md', 'A > C')
	]);
	assert.equal(tree.children.length, 1);
	assert.deepEqual(
		tree.children[0].children.map((c) => c.label).sort(),
		['B', 'C']
	);
});

test('a node whose ancestors have no row of their own gets them synthesized', () => {
	const tree = buildTree(ROOT, [row(['A', 'B', 'C'], 'c.md', 'A > B > C')]);
	const a = tree.children[0];
	const b = a.children[0];
	assert.equal(a.label, 'A');
	assert.equal(b.label, 'B');
	assert.equal(b.children[0].label, 'C');
	assert.equal(b.children[0].sourcePath, 'c.md');
	// Synthesized ancestors inherit the only citation below them, so no node in
	// a rendered map is ever left unclickable.
	assert.equal(a.sourcePath, 'c.md');
	assert.equal(a.headingPath, 'A > B > C');
});

test('a branch inherits its FIRST cited descendant, not the last', () => {
	const tree = buildTree(ROOT, [
		row(['A', 'B'], 'b.md', 'A > B'),
		row(['A', 'C'], 'c.md', 'A > C')
	]);
	assert.equal(tree.children[0].sourcePath, 'b.md');
});

test('a node that cites something itself keeps its own citation', () => {
	const tree = buildTree(ROOT, [row(['A'], 'a.md', 'A'), row(['A', 'B'], 'b.md', 'A > B')]);
	assert.equal(tree.children[0].sourcePath, 'a.md');
	assert.equal(tree.children[0].children[0].sourcePath, 'b.md');
});

test('the root is rendered — it is the topic, not a skipped title', () => {
	const tree = buildTree(ROOT, []);
	// Previously the outline started at tree.children, so markmap drew an
	// empty unlabelled root circle.
	assert.equal(
		treeToMarkdownOutline(tree),
		['- Türev', '  - <span class="mm-summary">Anlık değişim oranı.</span>'].join('\n')
	);
});

test('outline nests summary under its concept and the link under the summary', () => {
	const tree = buildTree(ROOT, [
		row(['Kısmi türevler'], 'p.md', 'Kısmi', 'Tek değişkene göre değişim.')
	]);
	const outline = treeToMarkdownOutline(tree, (n) =>
		n.sourcePath ? `/library/view?path=${n.sourcePath}` : null
	);
	assert.equal(
		outline,
		[
			'- Türev',
			'  - <span class="mm-summary">Anlık değişim oranı.</span>',
			'  - Kısmi türevler',
			'    - <span class="mm-summary">Tek değişkene göre değişim.</span>',
			'      - [Kaynağı aç](/library/view?path=p.md)'
		].join('\n')
	);
});

test('a node with no summary still gets its citation, one level down', () => {
	const tree = buildTree({ label: 'Kök', summary: '' }, [row(['A'], 'a.md', 'A')]);
	const outline = treeToMarkdownOutline(tree, () => '/x');
	assert.equal(outline, ['- Kök', '  - [Kaynağı aç](/x)', '  - A', '    - [Kaynağı aç](/x)'].join('\n'));
});

test('no linkFor means no citation lines at all', () => {
	const tree = buildTree(ROOT, [row(['A'], 'a.md', 'A', 'Açıklama.')]);
	assert.equal(
		treeToMarkdownOutline(tree),
		[
			'- Türev',
			'  - <span class="mm-summary">Anlık değişim oranı.</span>',
			'  - A',
			'    - <span class="mm-summary">Açıklama.</span>'
		].join('\n')
	);
});

test('brackets in a label or summary are escaped', () => {
	const tree = buildTree({ label: 'Kök', summary: '' }, [
		row(['Diziler [Bölüm 3]'], 'x.md', 'Diziler', 'Bkz. [ek].')
	]);
	const outline = treeToMarkdownOutline(tree, () => '/library/view?path=x.md');
	assert.match(outline, /- Diziler \\\[Bölüm 3\\\]/);
	assert.match(outline, /Bkz\. \\\[ek\\\]\./);
});

test('HTML in a label or summary is escaped, not rendered as markup', () => {
	// markmap-lib builds markdown-it with html:true, so an unescaped "<" from
	// model output would become real markup inside the SVG.
	const tree = buildTree({ label: 'Kök', summary: '' }, [
		row(['a < b & c'], 'x.md', 'X', '<script>alert(1)</script> & sonra')
	]);
	const outline = treeToMarkdownOutline(tree);
	assert.match(outline, /- a &lt; b &amp; c/);
	assert.ok(outline.includes('&lt;script&gt;alert(1)&lt;/script&gt; &amp; sonra'));
	assert.ok(!outline.includes('<script>'));
});

test('a short summary is a single span with no clamp', () => {
	const tree = buildTree({ label: 'Kök', summary: '' }, [row(['A'], 'a.md', 'A', 'Kısa.')]);
	const outline = treeToMarkdownOutline(tree);
	assert.ok(outline.includes('<span class="mm-summary">Kısa.</span>'));
	// Nothing to hide means nothing to click.
	assert.ok(!outline.includes('is-clamped'));
});

test('a long summary ships a preview and the full text, cut on a word', () => {
	const long = 'Türev bir fonksiyonun değişim oranını ölçer '.repeat(6).trim();
	const tree = buildTree({ label: 'Kök', summary: '' }, [row(['A'], 'a.md', 'A', long)]);
	const outline = treeToMarkdownOutline(tree);

	assert.ok(outline.includes('<span class="mm-summary is-clamped">'));
	const short = outline.match(/<span class="mm-short">([^<]*)<\/span>/)?.[1] ?? '';
	const full = outline.match(/<span class="mm-full">([^<]*)<\/span>/)?.[1] ?? '';

	assert.ok(short.endsWith('…'));
	assert.ok(short.length < full.length);
	assert.equal(full, long);
	// Cut on a word boundary, never mid-word.
	const withoutEllipsis = short.slice(0, -1).trimEnd();
	assert.ok(long.startsWith(withoutEllipsis));
	assert.ok(long[withoutEllipsis.length] === ' ' || long[withoutEllipsis.length] === undefined);
});

test('deeper trees keep indenting by one level per depth', () => {
	const tree = buildTree({ label: 'Kök', summary: '' }, [
		row(['A', 'B', 'C'], 'c.md', 'A > B > C')
	]);
	assert.equal(treeToMarkdownOutline(tree), ['- Kök', '  - A', '    - B', '      - C'].join('\n'));
});
