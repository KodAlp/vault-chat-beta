import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAndValidateMindMap, MIN_NODES, type CitedChunk } from './mindmap-validate';

const chunks = new Map<string, CitedChunk>([
	['S1', { path: 'wiki/os/scheduling.md', heading_path: 'Zamanlama > MLFQ' }],
	['S2', { path: 'wiki/os/scheduling.md', heading_path: 'Zamanlama > Lottery' }],
	['S3', { path: 'wiki/os/linux.md', heading_path: 'Çekirdek > CFS' }],
	['S4', { path: 'wiki/os/linux.md', heading_path: 'Çekirdek > Öncelikler' }],
	['S5', { path: 'wiki/os/fairness.md', heading_path: 'Adalet > Açlık' }],
	['S6', { path: 'wiki/os/fairness.md', heading_path: 'Adalet > Ölçüm' }]
]);

/** A map that satisfies every rule — the baseline each failing case mutates. */
function goodNodes() {
	return [
		{ path: ['Zamanlama politikaları', 'Geri besleme kuyruğu'], source_id: 'S1' },
		{ path: ['Zamanlama politikaları', 'Bilet tabanlı pay'], source_id: 'S2' },
		{ path: ['Zamanlama politikaları', 'Sanal çalışma zamanı'], source_id: 'S3' },
		{ path: ['Ödünleşimler', 'Öncelik ile gecikme'], source_id: 'S4' },
		{ path: ['Ödünleşimler', 'Aç kalan süreç'], source_id: 'S5' },
		{ path: ['Ödünleşimler', 'Payın ölçülmesi'], source_id: 'S6' }
	];
}
const raw = (nodes: unknown) => JSON.stringify({ nodes });

test('a well-formed concept map is accepted and resolved to real paths', () => {
	const r = parseAndValidateMindMap(raw(goodNodes()), chunks);
	assert.equal(r.ok, true);
	if (!r.ok) return;
	assert.equal(r.nodes.length, 6);
	// source_path/heading_path come from the server's own chunk table, never
	// from the model — that is the whole point of citing an id.
	assert.equal(r.nodes[0].source_path, 'wiki/os/scheduling.md');
	assert.equal(r.nodes[0].heading_path, 'Zamanlama > MLFQ');
	assert.deepEqual(r.nodes[0].path, ['Zamanlama politikaları', 'Geri besleme kuyruğu']);
});

test('non-JSON and schema-invalid responses are rejected, not thrown', () => {
	assert.equal(parseAndValidateMindMap('not json at all', chunks).ok, false);
	assert.equal(parseAndValidateMindMap(raw([{ path: [], source_id: 'S1' }]), chunks).ok, false);
	assert.equal(parseAndValidateMindMap(raw([]), chunks).ok, false);
});

test('an invented source_id is rejected', () => {
	const nodes = goodNodes();
	nodes[0].source_id = 'S99';
	const r = parseAndValidateMindMap(raw(nodes), chunks);
	assert.equal(r.ok, false);
	if (r.ok) return;
	assert.match(r.error, /source_id/);
});

test('a citation id leaking into path is rejected', () => {
	// The regression that showed up the first time the id-based schema ran:
	// path: ["S4", "ZooKeeper's Architecture"].
	const nodes = goodNodes();
	nodes[2].path = ['S3', 'Sanal çalışma zamanı'];
	const r = parseAndValidateMindMap(raw(nodes), chunks);
	assert.equal(r.ok, false);
	if (r.ok) return;
	assert.match(r.error, /kimli/);
});

test('a map whose labels mostly copy the source headings is rejected', () => {
	const nodes = goodNodes().map((n, i) => ({
		...n,
		path: ['Kök', [...chunks.values()][i].heading_path.split('>').pop()!.trim()]
	}));
	const r = parseAndValidateMindMap(raw(nodes), chunks);
	assert.equal(r.ok, false);
	if (r.ok) return;
	assert.match(r.error, /başlığının kopyası/);
});

test('a single copied heading among real concepts is tolerated', () => {
	// Some headings genuinely are the concept's name; only a majority is the
	// table-of-contents failure this rule targets.
	const nodes = goodNodes();
	nodes[0].path = ['Zamanlama politikaları', 'MLFQ'];
	assert.equal(parseAndValidateMindMap(raw(nodes), chunks).ok, true);
});

test('trailing punctuation and case do not hide a copied heading', () => {
	const nodes = goodNodes().map((n, i) => ({
		...n,
		path: ['Kök', [...chunks.values()][i].heading_path.split('>').pop()!.trim().toUpperCase() + ' :']
	}));
	assert.equal(parseAndValidateMindMap(raw(nodes), chunks).ok, false);
});

test('a map built from a single source is rejected when several were offered', () => {
	const nodes = goodNodes().map((n) => ({ ...n, source_id: 'S1' }));
	const r = parseAndValidateMindMap(raw(nodes), chunks);
	assert.equal(r.ok, false);
	if (r.ok) return;
	assert.match(r.error, /tek bir kaynağa/);
});

test('a single-source map is fine when only one source was offered', () => {
	const only = new Map<string, CitedChunk>([
		['S1', { path: 'wiki/os/scheduling.md', heading_path: 'Zamanlama > MLFQ' }]
	]);
	const nodes = [{ path: ['Zamanlama politikaları', 'Geri besleme kuyruğu'], source_id: 'S1' }];
	// The node floor clamps to how many chunks exist, so one chunk means one
	// node is enough — the floor must never make a small vault unusable.
	assert.equal(parseAndValidateMindMap(raw(nodes), only).ok, true);
});

test('a two-node map that games every other rule is still rejected', () => {
	const nodes = [
		{ path: ['Zamanlama politikaları'], source_id: 'S1' },
		{ path: ['Çekirdek tarafı'], source_id: 'S3' }
	];
	const r = parseAndValidateMindMap(raw(nodes), chunks);
	assert.equal(r.ok, false);
	if (r.ok) return;
	assert.match(r.error, new RegExp(String(MIN_NODES)));
});
