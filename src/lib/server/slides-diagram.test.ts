import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeDiagram, isRenderableDiagram, renderDiagramSvg, type DiagramSpec } from './slides-diagram';

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
	// Excludes the arrowhead marker's own <path> inside <defs>, which also
	// starts with "<path " — only an actual curved edge has fill="none".
	assert.equal((svg.match(/<path [^>]*fill="none"/g) ?? []).length, 1);
	assert.match(svg, /repeats/);
	assert.match(svg, /marker-end="url\(#slide-diagram-arrow\)"/);
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

test('renderDiagramSvg grows taller with more nodes, deterministically (same input -> same output)', () => {
	const spec: DiagramSpec = { nodes: [{ id: 'a', label: 'One' }, { id: 'b', label: 'Two' }], edges: [] };
	const first = renderDiagramSvg(spec);
	const second = renderDiagramSvg(spec);
	assert.equal(first, second);

	const taller = renderDiagramSvg({
		nodes: [...spec.nodes, { id: 'c', label: 'Three' }],
		edges: []
	});
	const heightOf = (svg: string) => Number(/viewBox="0 0 \d+ (\d+)"/.exec(svg)?.[1]);
	assert.ok(heightOf(taller) > heightOf(first));
});
