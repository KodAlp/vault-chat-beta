/**
 * F13-3 (Aşama 11) — deterministic SVG renderer for the `diagram` slide
 * layout. Pure module (no provider/env import), own *.test.ts, same reason
 * mindmap-validate.ts and slides-deck.ts were split out: importable from
 * plain `tsx --test`.
 *
 * Design note (see docs/yol-2026-09-23.md Aşama 11, Bulgu 3): the slide
 * display iframe has no `allow-scripts` (Aşama 9), which rules out
 * client-side Mermaid. Rather than have the model emit raw SVG/Mermaid text
 * (an injection surface, and a format small local models render unreliably),
 * the model only ever supplies structured node/edge labels (validated by
 * slides-schema.ts's zod shape) and this function is the ONLY thing that
 * produces markup — every label is escaped, everything else is a fixed
 * template. There is no injection surface here to defend against; this is
 * data-to-template rendering, not sanitization of untrusted markup.
 *
 * SECOND design note, found by a real-Ollama trial after the first version
 * shipped (2026-09-24): marp-core runs all markdown body content through the
 * `xss` package with its own tag/attribute allowlist (`Marp.html`, 71 tags,
 * no `svg`/`rect`/`path`/... at all) — with no matching entry, the ENTIRE
 * `<svg>` block was being HTML-escaped and shown as literal visible text on
 * the slide, not rendered. Fixing that needs a custom `html` allowlist
 * passed to `new Marp({ html: {...Marp.html, ...SLIDE_DIAGRAM_HTML_ALLOWLIST} })`
 * (see slides-deck.ts/generate-slides.ts) — but that filter ALSO lowercases
 * every attribute NAME it passes through (harmless for already-lowercase
 * names like `stroke-width`, fatal for SVG's camelCase-only attributes:
 * `viewBox`, `markerWidth`, `refX`, ... become `viewbox`, `markerwidth`,
 * `refx`, which a browser's SVG foreign-content parser does not recognize
 * — the element renders as an inert, invisible or unscaled shape). The
 * fix here is to never need a camelCase SVG attribute in the first place:
 * no `<marker>`/`<defs>` (arrowheads are hand-drawn `<polygon>` triangles
 * instead, computed directly since both edge shapes below have a FIXED,
 * known approach angle — straight edges always arrive from directly above,
 * curved edges always arrive from directly to the right), and no `viewBox`
 * (the layout scales its own box height/gap/font-size to fit a fixed
 * `width`/`height` — both already lowercase — instead of relying on the
 * SVG viewport to scale a taller-than-budget canvas down via CSS).
 */

export interface DiagramNode {
	id: string;
	label: string;
}

export interface DiagramEdge {
	from: string;
	to: string;
	label?: string;
}

export interface DiagramSpec {
	nodes: DiagramNode[];
	edges: DiagramEdge[];
}

/**
 * Merge with the real `Marp.html` default (`new Marp({ html: { ...Marp.html,
 * ...SLIDE_DIAGRAM_HTML_ALLOWLIST } })`) — never pass this alone, and never
 * pass `html: true` (that would let ANY raw HTML through from every other
 * layout's content_markdown too, not just this one deterministic template).
 * Every attribute name here is already lowercase — see the module doc
 * comment above for why that's load-bearing, not a style choice.
 */
export const SLIDE_DIAGRAM_HTML_ALLOWLIST = {
	svg: { width: true, height: true, role: true, 'aria-label': true, xmlns: true },
	rect: { x: true, y: true, width: true, height: true, rx: true, fill: true, stroke: true, 'stroke-width': true },
	text: {
		x: true,
		y: true,
		'text-anchor': true,
		'dominant-baseline': true,
		'font-family': true,
		'font-size': true,
		fill: true
	},
	line: { x1: true, y1: true, x2: true, y2: true, stroke: true, 'stroke-width': true },
	path: { d: true, fill: true, stroke: true, 'stroke-width': true },
	polygon: { points: true, fill: true }
};

const MAX_LABEL_CHARS = 42;
const MAX_EDGE_LABEL_CHARS = 20;
const BOX_WIDTH = 440;
const CANVAS_WIDTH = 680;
/** Fixed budget, never exceeded — the layout shrinks to fit this instead of
 * emitting a taller SVG and relying on viewBox/CSS to scale it down. */
const MAX_CANVAS_HEIGHT = 440;
const BASE_BOX_HEIGHT = 60;
const BASE_ROW_GAP = 40;
const BASE_PAD_Y = 24;
const BASE_NODE_FONT = 21;
const MIN_NODE_FONT = 14;
const EDGE_FONT = 16;
const ARROW_LEN = 9;
const ARROW_HALF_WIDTH = 5;
/** Repeated edges between the same ordered (from, to) pair — e.g. a
 * request/response pair modeled as two separate labeled arrows — would
 * otherwise draw exactly on top of each other. Each repeat after the first
 * shifts over by this many px. */
const LANE_OFFSET = 26;

function escapeSvgText(s: string): string {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function truncate(s: string, max: number): string {
	const t = s.trim();
	return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * Drops an edge that references an unknown node id or points a node at
 * itself, and dedupes node ids (first occurrence wins) — same soft-drop
 * philosophy as mindmap-validate.ts's unknown-citation handling: an invalid
 * piece is quietly removed rather than failing the whole slide.
 */
export function sanitizeDiagram(raw: DiagramSpec): DiagramSpec {
	const seenIds = new Set<string>();
	const nodes = raw.nodes.filter((n) => {
		if (seenIds.has(n.id)) return false;
		seenIds.add(n.id);
		return true;
	});
	const edges = raw.edges.filter((e) => seenIds.has(e.from) && seenIds.has(e.to) && e.from !== e.to);
	return { nodes, edges };
}

/** True once a spec is sanitized: at least one node survived, so there's
 * something worth rendering. Callers use this to decide whether to fall
 * back to plain content_markdown instead of an empty/near-empty diagram. */
export function isRenderableDiagram(spec: DiagramSpec): boolean {
	return sanitizeDiagram(spec).nodes.length >= 1;
}

interface Layout {
	boxHeight: number;
	rowGap: number;
	padY: number;
	nodeFont: number;
	canvasHeight: number;
}

/** Shrinks box height/gap/padding/font together, only as much as needed, so
 * any node count from 1 to schema's max of 8 fits MAX_CANVAS_HEIGHT without
 * ever needing the caller to scale the SVG itself. */
function layoutFor(nodeCount: number): Layout {
	const naturalHeight =
		BASE_PAD_Y * 2 + nodeCount * BASE_BOX_HEIGHT + Math.max(0, nodeCount - 1) * BASE_ROW_GAP;
	const scale = naturalHeight > MAX_CANVAS_HEIGHT ? MAX_CANVAS_HEIGHT / naturalHeight : 1;
	return {
		boxHeight: BASE_BOX_HEIGHT * scale,
		rowGap: BASE_ROW_GAP * scale,
		padY: BASE_PAD_Y * scale,
		nodeFont: Math.max(MIN_NODE_FONT, BASE_NODE_FONT * scale),
		canvasHeight: Math.round(naturalHeight * scale)
	};
}

/** Downward-pointing triangle, tip at (x, tipY) — used where a straight
 * edge always arrives from directly above. */
function arrowDown(x: number, tipY: number): string {
	const points = `${x - ARROW_HALF_WIDTH},${tipY - ARROW_LEN} ${x + ARROW_HALF_WIDTH},${tipY - ARROW_LEN} ${x},${tipY}`;
	return `<polygon points="${points}" fill="oklch(76% 0.17 155)"/>`;
}

/** Leftward-pointing triangle, tip at (tipX, y) — used where a curved edge
 * (see the module doc comment: its end tangent is always exactly
 * horizontal by construction) always arrives from directly the right. */
function arrowLeft(tipX: number, y: number): string {
	const points = `${tipX + ARROW_LEN},${y - ARROW_HALF_WIDTH} ${tipX + ARROW_LEN},${y + ARROW_HALF_WIDTH} ${tipX},${y}`;
	return `<polygon points="${points}" fill="oklch(76% 0.17 155)"/>`;
}

/**
 * Vertical flow: nodes stacked top-to-bottom in the given order. An edge
 * between two consecutive nodes (in that order, forward direction) draws a
 * straight center arrow. Every other edge (a skip, a back-reference, a
 * cycle) draws a curved arrow bulging out to the right, offset further out
 * the larger the index gap — keeps multiple such edges from overlapping and
 * naturally renders a "last node back to first" cycle as the widest loop.
 * A repeated (from, to) pair (same direction, more than once) shifts each
 * repeat over by LANE_OFFSET so they don't draw on top of each other.
 */
export function renderDiagramSvg(spec: DiagramSpec): string {
	const { nodes, edges } = sanitizeDiagram(spec);
	if (nodes.length === 0) return '';

	const indexOf = new Map(nodes.map((n, i) => [n.id, i]));
	const { boxHeight, rowGap, padY, nodeFont, canvasHeight } = layoutFor(nodes.length);
	const centerX = CANVAS_WIDTH / 2;
	const boxX = centerX - BOX_WIDTH / 2;
	const boxRight = boxX + BOX_WIDTH;
	const nodeCenterY = (index: number) => padY + boxHeight / 2 + index * (boxHeight + rowGap);

	const boxes = nodes
		.map((n, i) => {
			const y = i * (boxHeight + rowGap) + padY;
			return `<rect x="${boxX}" y="${y}" width="${BOX_WIDTH}" height="${boxHeight}" rx="12" fill="oklch(20% 0.02 165)" stroke="oklch(76% 0.17 155)" stroke-width="2"/><text x="${centerX}" y="${y + boxHeight / 2}" text-anchor="middle" dominant-baseline="central" font-family="Satoshi, system-ui, sans-serif" font-size="${nodeFont}" fill="oklch(93% 0.004 165)">${escapeSvgText(truncate(n.label, MAX_LABEL_CHARS))}</text>`;
		})
		.join('');

	const lane = new Map<string, number>();
	const nextLane = (key: string): number => {
		const n = lane.get(key) ?? 0;
		lane.set(key, n + 1);
		return n;
	};

	const edgeMarkup = edges
		.map((e) => {
			const fromIdx = indexOf.get(e.from)!;
			const toIdx = indexOf.get(e.to)!;
			const fromY = nodeCenterY(fromIdx);
			const toY = nodeCenterY(toIdx);
			const laneOffset = nextLane(`${fromIdx}->${toIdx}`) * LANE_OFFSET;
			const labelOpen = `<text text-anchor="middle" font-family="ui-monospace, 'SF Mono', 'Cascadia Code', Menlo, Consolas, monospace" font-size="${EDGE_FONT}" fill="oklch(76% 0.17 155)"`;

			const isDirectForward = toIdx === fromIdx + 1;
			if (isDirectForward) {
				const x = centerX + laneOffset;
				const y1 = fromY + boxHeight / 2;
				const y2 = toY - boxHeight / 2;
				const label = e.label
					? `${labelOpen} x="${x + 16}" y="${(y1 + y2) / 2}">${escapeSvgText(truncate(e.label, MAX_EDGE_LABEL_CHARS))}</text>`
					: '';
				return `<line x1="${x}" y1="${y1}" x2="${x}" y2="${y2}" stroke="oklch(76% 0.17 155)" stroke-width="2"/>${arrowDown(x, y2)}${label}`;
			}

			const gap = Math.abs(toIdx - fromIdx);
			const bulge = boxRight + 36 + gap * 22 + laneOffset;
			const label = e.label
				? `${labelOpen} x="${bulge + 6}" y="${(fromY + toY) / 2}">${escapeSvgText(truncate(e.label, MAX_EDGE_LABEL_CHARS))}</text>`
				: '';
			return `<path d="M ${boxRight},${fromY} C ${bulge},${fromY} ${bulge},${toY} ${boxRight},${toY}" fill="none" stroke="oklch(76% 0.17 155)" stroke-width="2"/>${arrowLeft(boxRight, toY)}${label}`;
		})
		.join('');

	return `<svg width="${CANVAS_WIDTH}" height="${canvasHeight}" role="img" aria-label="diagram" xmlns="http://www.w3.org/2000/svg">${edgeMarkup}${boxes}</svg>`;
}
