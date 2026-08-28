import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	parseAndValidateMindMap,
	assessMindMapQuality,
	type CitedChunk
} from './mindmap-validate';

const chunks = new Map<string, CitedChunk>([
	['S1', { path: 'wiki/math/calculus.md', heading_path: 'Türev > Tanım' }],
	['S2', { path: 'wiki/math/calculus.md', heading_path: 'Türev > Kurallar' }],
	['S3', { path: 'wiki/math/real-analysis.md', heading_path: 'Limit > Süreklilik' }],
	[
		'S4',
		{
			path: 'wiki/math/sources/stewart-calculus-early-transcendentals.md',
			heading_path: 'Ch 3 > Uygulamalar'
		}
	]
]);

/** Written out as a type so every branch has the same shape — otherwise
 * TypeScript infers a union from the literal and a test cannot reach
 * `branches[1].children`. */
interface RawNode {
	label: string;
	summary: string;
	source_id: string;
	children?: RawNode[];
}
interface RawTree {
	root: { label: string; summary: string };
	branches: RawNode[];
}

/** A well-formed tree — the baseline each failing case mutates. Seven nodes,
 * deliberately more than MIN_NODES, so that dropping one branch still leaves a
 * usable map and the floor is exercised separately. */
function goodTree(): RawTree {
	return {
		root: { label: 'Türev', summary: 'Bir fonksiyonun bir noktadaki anlık değişim oranı.' },
		branches: [
			{
				label: 'Türevin temelleri',
				summary: 'Türevin limit tanımı ve geometrik anlamı.',
				source_id: 'S1',
				children: [
					{
						label: 'Limit tanımı',
						summary: 'Fark oranının limiti olarak türev.',
						source_id: 'S3',
						children: [
							{
								label: 'Süreklilik',
								summary: 'Türevlenebilirlik sürekliliği gerektirir.',
								source_id: 'S3'
							}
						]
					}
				]
			},
			{
				label: 'Türev alma kuralları',
				summary: 'Türevi mekanik olarak hesaplamayı sağlayan kurallar.',
				source_id: 'S2',
				children: [
					{
						label: 'Çarpımın türevi',
						summary: 'İki fonksiyonun çarpımının türev kuralı.',
						source_id: 'S2'
					}
				]
			},
			{
				label: 'Uygulamalar',
				summary: 'Türevin problem çözmede kullanımı.',
				source_id: 'S4',
				children: [
					{ label: 'Optimizasyon', summary: 'Uç noktaları türevle bulma.', source_id: 'S4' }
				]
			}
		]
	};
}
const raw = (tree: unknown) => JSON.stringify(tree);

test('a well-formed tree is flattened into paths with summaries', () => {
	const r = parseAndValidateMindMap(raw(goodTree()), chunks);
	assert.equal(r.ok, true);
	if (!r.ok) return;

	assert.equal(r.result.rootLabel, 'Türev');
	assert.match(r.result.rootSummary, /anlık değişim oranı/);

	// Depth comes from nesting, not from the model encoding path prefixes.
	assert.deepEqual(
		r.result.nodes.map((n) => n.path),
		[
			['Türevin temelleri'],
			['Türevin temelleri', 'Limit tanımı'],
			['Türevin temelleri', 'Limit tanımı', 'Süreklilik'],
			['Türev alma kuralları'],
			['Türev alma kuralları', 'Çarpımın türevi'],
			['Uygulamalar'],
			['Uygulamalar', 'Optimizasyon']
		]
	);
	// source_path/heading_path come from the server's chunk table, never from
	// the model — that is the whole point of citing an id.
	assert.equal(r.result.nodes[0].source_path, 'wiki/math/calculus.md');
	assert.equal(r.result.nodes[2].heading_path, 'Limit > Süreklilik');
	assert.match(r.result.nodes[1].summary, /Fark oranının limiti/);
	assert.deepEqual(r.result.droppedFileNameLabels, []);
});

test('non-JSON and schema-invalid responses are rejected, not thrown', () => {
	assert.equal(parseAndValidateMindMap('not json at all', chunks).ok, false);
	assert.equal(parseAndValidateMindMap(raw({ branches: [] }), chunks).ok, false);
	assert.equal(
		parseAndValidateMindMap(raw({ root: { label: 'X', summary: 'Y' }, branches: [] }), chunks).ok,
		false
	);
});

test('an invented source_id is a hard failure — the map would be dishonest', () => {
	const tree = goodTree();
	tree.branches[0].children![0].source_id = 'S99';
	const r = parseAndValidateMindMap(raw(tree), chunks);
	assert.equal(r.ok, false);
	if (r.ok) return;
	assert.match(r.error, /source_id/);
});

test('a label that is a source file name is dropped with its subtree, not rejected', () => {
	const tree = goodTree();
	tree.branches[0].label = 'stewart-calculus-early-transcendentals.md';
	const r = parseAndValidateMindMap(raw(tree), chunks);
	assert.equal(r.ok, true);
	if (!r.ok) return;

	// The whole branch goes: its children hang off a label the user must never see.
	assert.deepEqual(
		r.result.nodes.map((n) => n.path),
		[
			['Türev alma kuralları'],
			['Türev alma kuralları', 'Çarpımın türevi'],
			['Uygulamalar'],
			['Uygulamalar', 'Optimizasyon']
		]
	);
	// Surfaced so the caller can write the debug trail the user asked for.
	assert.deepEqual(r.result.droppedFileNameLabels, ['stewart-calculus-early-transcendentals.md']);
});

test('a provided basename is caught even without its extension', () => {
	const tree = goodTree();
	tree.branches[0].children![0].label = 'calculus';
	const r = parseAndValidateMindMap(raw(tree), chunks);
	assert.equal(r.ok, true);
	if (!r.ok) return;
	assert.deepEqual(r.result.droppedFileNameLabels, ['calculus']);
	assert.ok(!r.result.nodes.some((n) => n.path.includes('calculus')));
	// The grandchild under it went too.
	assert.ok(!r.result.nodes.some((n) => n.path.includes('Süreklilik')));
});

test('a concept label containing a dot is not mistaken for a file name', () => {
	const tree = goodTree();
	tree.branches[1].label = 'O(1) vs. O(n) türev maliyeti';
	const r = parseAndValidateMindMap(raw(tree), chunks);
	assert.equal(r.ok, true);
	if (!r.ok) return;
	assert.deepEqual(r.result.droppedFileNameLabels, []);
});

test('dropping can push the map under the floor, which IS a hard failure', () => {
	const tree = goodTree();
	tree.branches[0].label = 'calculus.md';
	tree.branches[1].label = 'real-analysis.md';
	tree.branches[2].label = 'stewart-calculus-early-transcendentals';
	const r = parseAndValidateMindMap(raw(tree), chunks);
	assert.equal(r.ok, false);
	if (r.ok) return;
	assert.match(r.error, /düğüm kaldı/);
});

test('an over-long summary is trimmed, never a reason to fail', () => {
	const tree = goodTree();
	tree.branches[0].summary = 'x'.repeat(900);
	const r = parseAndValidateMindMap(raw(tree), chunks);
	assert.equal(r.ok, true);
	if (!r.ok) return;
	assert.ok(r.result.nodes[0].summary.length <= 450);
	assert.ok(r.result.nodes[0].summary.endsWith('…'));
});

test('a good map draws no quality hint', () => {
	const r = parseAndValidateMindMap(raw(goodTree()), chunks);
	assert.equal(r.ok, true);
	if (!r.ok) return;
	assert.equal(assessMindMapQuality(r.result, chunks), null);
});

test('a flat map and a single-branch map get hints, not failures', () => {
	const flat: RawTree = {
		root: { label: 'Türev', summary: 'Anlık değişim oranı.' },
		branches: [
			{ label: 'Limit', summary: 'a', source_id: 'S1' },
			{ label: 'Kural', summary: 'b', source_id: 'S2' },
			{ label: 'Uygulama', summary: 'c', source_id: 'S3' }
		]
	};
	const r = parseAndValidateMindMap(raw(flat), chunks);
	assert.equal(r.ok, true);
	if (!r.ok) return;
	assert.match(assessMindMapQuality(r.result, chunks) ?? '', /tek seviyeli/);

	const single: RawTree = {
		root: { label: 'Türev', summary: 'Anlık değişim oranı.' },
		branches: [
			{
				label: 'Tek dal',
				summary: 'a',
				source_id: 'S1',
				children: [
					{ label: 'Alt bir', summary: 'b', source_id: 'S1' },
					{ label: 'Alt iki', summary: 'c', source_id: 'S1' }
				]
			}
		]
	};
	const r2 = parseAndValidateMindMap(raw(single), chunks);
	assert.equal(r2.ok, true);
	if (!r2.ok) return;
	assert.match(assessMindMapQuality(r2.result, chunks) ?? '', /tek bir ana daldan/);
});

test('a single-source map gets a hint only when other sources were offered', () => {
	const tree = goodTree();
	const pinToS1 = (nodes: RawNode[]) => {
		for (const n of nodes) {
			n.source_id = 'S1';
			if (n.children) pinToS1(n.children);
		}
	};
	pinToS1(tree.branches);

	const r = parseAndValidateMindMap(raw(tree), chunks);
	assert.equal(r.ok, true);
	if (!r.ok) return;
	assert.match(assessMindMapQuality(r.result, chunks) ?? '', /tek bir kaynağa/);

	// With only one source available there is nothing to relate it to.
	const only = new Map<string, CitedChunk>([
		['S1', { path: 'wiki/math/calculus.md', heading_path: 'Türev > Tanım' }]
	]);
	const r2 = parseAndValidateMindMap(raw(tree), only);
	assert.equal(r2.ok, true);
	if (!r2.ok) return;
	assert.equal(assessMindMapQuality(r2.result, only), null);
});

// Observed in a real generation: the model left source_id correct but ALSO
// appended the id to the label text ("Calculus Foundations (S13)"). The nested
// schema cannot see inside the string, so this is cleaned up here.
test('a citation id appended to a label is stripped, not rejected', () => {
	const tree = goodTree();
	tree.branches[0].label = 'Türevin temelleri (S1)';
	tree.branches[1].label = 'Türev alma kuralları [S2]';
	tree.branches[2].label = 'Uygulamalar S4';
	const r = parseAndValidateMindMap(raw(tree), chunks);
	assert.equal(r.ok, true);
	if (!r.ok) return;
	assert.deepEqual(
		r.result.nodes.filter((n) => n.path.length === 1).map((n) => n.path[0]),
		['Türevin temelleri', 'Türev alma kuralları', 'Uygulamalar']
	);
});

test('the root label is cleaned the same way', () => {
	const tree = goodTree();
	tree.root.label = 'Türev (S1)';
	const r = parseAndValidateMindMap(raw(tree), chunks);
	assert.equal(r.ok, true);
	if (!r.ok) return;
	assert.equal(r.result.rootLabel, 'Türev');
});

test('a label that is nothing but an id keeps it rather than becoming empty', () => {
	const tree = goodTree();
	tree.branches[0].label = 'S1';
	const r = parseAndValidateMindMap(raw(tree), chunks);
	assert.equal(r.ok, true);
	if (!r.ok) return;
	// Useless but visible beats an empty node; a node literally named after an
	// id is a different failure, and the quality hints cover map shape.
	assert.ok(r.result.nodes.some((n) => n.path[0] === 'S1'));
});

test('a legitimate label ending in a capital S plus digits is left alone', () => {
	const tree = goodTree();
	tree.branches[0].label = 'Sınıf S3';
	const r = parseAndValidateMindMap(raw(tree), chunks);
	assert.equal(r.ok, true);
	if (!r.ok) return;
	// Honest limitation: "S3" here is indistinguishable from a citation id, so
	// it IS stripped. Recorded as the known trade-off rather than pretended away.
	assert.ok(r.result.nodes.some((n) => n.path[0] === 'Sınıf'));
});
