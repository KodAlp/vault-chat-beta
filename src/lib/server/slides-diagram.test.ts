import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	sanitizeDiagram,
	isRenderableDiagram,
	renderDiagramSvg,
	SLIDE_DIAGRAM_HTML_ALLOWLIST,
	type DiagramSpec
} from './slides-diagram';

test('sanitizeDiagram dedupes node ids, keeping the first occurrence', () => {
	const spec: DiagramSpec = {
		nodes: [
			{ id: 'a', label: 'First' },
			{ id: 'a', label: 'Duplicate, dropped' },
			{ id: 'b', label: 'Second' }
		],
		edges: []
	};
	const { nodes } = sanitizeDiagram(spec);
	assert.deepEqual(
		nodes.map((n) => n.label),
		['First', 'Second']
	);
});

test('sanitizeDiagram drops an edge pointing at an unknown node id', () => {
	const spec: DiagramSpec = {
		nodes: [{ id: 'a', label: 'A' }],
		edges: [{ from: 'a', to: 'ghost' }]
	};
	assert.deepEqual(sanitizeDiagram(spec).edges, []);
});

test('sanitizeDiagram drops a self-loop edge', () => {
	const spec: DiagramSpec = {
		nodes: [{ id: 'a', label: 'A' }],
		edges: [{ from: 'a', to: 'a' }]
	};
	assert.deepEqual(sanitizeDiagram(spec).edges, []);
});

test('sanitizeDiagram keeps a valid edge between two real nodes', () => {
	const spec: DiagramSpec = {
		nodes: [
			{ id: 'a', label: 'A' },
			{ id: 'b', label: 'B' }
		],
		edges: [{ from: 'a', to: 'b', label: 'then' }]
	};
	const { edges } = sanitizeDiagram(spec);
	assert.equal(edges.length, 1);
	assert.equal(edges[0].label, 'then');
});

test('isRenderableDiagram is false once sanitizing removes every node', () => {
	assert.equal(isRenderableDiagram({ nodes: [], edges: [] }), false);
});

test('isRenderableDiagram is true with at least one surviving node, even with no edges', () => {
	assert.equal(isRenderableDiagram({ nodes: [{ id: 'a', label: 'Solo' }], edges: [] }), true);
});

test('renderDiagramSvg returns an empty string for a spec with no nodes', () => {
	assert.equal(renderDiagramSvg({ nodes: [], edges: [] }), '');
});

test('renderDiagramSvg emits one <rect>/<text> pair per surviving node', () => {
	const svg = renderDiagramSvg({
		nodes: [
			{ id: 'a', label: 'Step One' },
			{ id: 'b', label: 'Step Two' },
			{ id: 'c', label: 'Step Three' }
		],
		edges: []
	});
	assert.equal((svg.match(/<rect /g) ?? []).length, 3);
	assert.equal((svg.match(/<text /g) ?? []).length, 3);
	assert.match(svg, /Step One/);
	assert.match(svg, /Step Three/);
	assert.match(svg, /^<svg /);
});

test('renderDiagramSvg draws a straight <line> for a direct forward edge, a curved <path> otherwise', () => {
	const svg = renderDiagramSvg({
		nodes: [
			{ id: 'a', label: 'A' },
			{ id: 'b', label: 'B' },
			{ id: 'c', label: 'C' }
		],
		// a->b is direct forward (adjacent, in order): straight line.
		// c->a is a back-reference (cycle close): curved path.
		edges: [
			{ from: 'a', to: 'b' },
			{ from: 'c', to: 'a', label: 'repeats' }
		]
	});
	assert.equal((svg.match(/<line /g) ?? []).length, 1);
	assert.equal((svg.match(/<path /g) ?? []).length, 1);
	assert.match(svg, /repeats/);
	// Arrowheads are hand-drawn <polygon>s (see the module's second design
	// note — an SVG <marker> needs camelCase attributes that marp-core's xss
	// filter lowercases into brokenness), one per edge.
	assert.equal((svg.match(/<polygon /g) ?? []).length, 2);
	assert.doesNotMatch(svg, /<marker /);
	assert.doesNotMatch(svg, /viewBox/);
});

test('renderDiagramSvg escapes HTML-significant characters in labels (data, not markup, from the model)', () => {
	const svg = renderDiagramSvg({
		nodes: [{ id: 'a', label: '<script>alert(1)</script> & "quoted"' }],
		edges: []
	});
	assert.doesNotMatch(svg, /<script>/);
	assert.match(svg, /&lt;script&gt;/);
	assert.match(svg, /&amp;/);
	assert.match(svg, /&quot;quoted&quot;/);
});

test('renderDiagramSvg truncates an overlong label rather than overflowing the box', () => {
	const longLabel = 'x'.repeat(200);
	const svg = renderDiagramSvg({ nodes: [{ id: 'a', label: longLabel }], edges: [] });
	assert.doesNotMatch(svg, new RegExp('x'.repeat(100)));
	assert.match(svg, /…/);
});

function heightOf(svg: string): number {
	return Number(/height="(\d+)"/.exec(svg)?.[1]);
}

test('renderDiagramSvg grows taller with more nodes, deterministically (same input -> same output)', () => {
	const spec: DiagramSpec = { nodes: [{ id: 'a', label: 'One' }, { id: 'b', label: 'Two' }], edges: [] };
	const first = renderDiagramSvg(spec);
	const second = renderDiagramSvg(spec);
	assert.equal(first, second);

	const taller = renderDiagramSvg({
		nodes: [...spec.nodes, { id: 'c', label: 'Three' }],
		edges: []
	});
	assert.ok(heightOf(taller) > heightOf(first));
});

test('renderDiagramSvg never exceeds its fixed height budget, even at the schema max of 8 nodes', () => {
	const eightNodes: DiagramSpec = {
		nodes: Array.from({ length: 8 }, (_, i) => ({ id: `n${i}`, label: `Adım ${i + 1}` })),
		edges: []
	};
	const svg = renderDiagramSvg(eightNodes);
	// No viewBox anywhere (see the module doc comment) — the layout shrinks
	// box height/gap/font to fit a fixed budget instead of relying on the
	// SVG viewport to scale a taller-than-budget canvas down.
	assert.doesNotMatch(svg, /viewBox/);
	assert.ok(heightOf(svg) <= 440, `height ${heightOf(svg)} exceeds the fixed budget`);
	// All 8 boxes still present, not silently dropped to make room.
	assert.equal((svg.match(/<rect /g) ?? []).length, 8);
});

test('SLIDE_DIAGRAM_HTML_ALLOWLIST uses only already-lowercase attribute names', () => {
	// Regression guard for the real bug (2026-09-24): marp-core's xss filter
	// lowercases every attribute NAME it lets through. A camelCase entry here
	// (viewBox, markerWidth, refX, ...) would silently stop working the same
	// way the first version of this renderer did — this test fails loudly
	// instead if one ever creeps back in.
	for (const [tag, attrs] of Object.entries(SLIDE_DIAGRAM_HTML_ALLOWLIST)) {
		assert.equal(tag, tag.toLowerCase(), `tag ${tag} is not lowercase`);
		for (const attr of Object.keys(attrs)) {
			assert.equal(attr, attr.toLowerCase(), `attribute ${attr} on <${tag}> is not lowercase`);
		}
	}
});
