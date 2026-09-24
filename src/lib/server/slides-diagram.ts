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

const MAX_LABEL_CHARS = 42;
const MAX_EDGE_LABEL_CHARS = 20;
const BOX_WIDTH = 440;
const BOX_HEIGHT = 60;
const ROW_GAP = 54;
const PAD_Y = 24;
const CANVAS_WIDTH = 680;

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

function nodeCenterY(index: number): number {
	return PAD_Y + BOX_HEIGHT / 2 + index * (BOX_HEIGHT + ROW_GAP);
}

/**
 * Vertical flow: nodes stacked top-to-bottom in the given order. An edge
 * between two consecutive nodes (in that order, forward direction) draws a
 * straight center arrow. Every other edge (a skip, a back-reference, a
 * cycle) draws a curved arrow bulging out to the right, offset further out
 * the larger the index gap — keeps multiple such edges from overlapping and
 * naturally renders a "last node back to first" cycle as the widest loop.
 */
export function renderDiagramSvg(spec: DiagramSpec): string {
	const { nodes, edges } = sanitizeDiagram(spec);
	if (nodes.length === 0) return '';

	const indexOf = new Map(nodes.map((n, i) => [n.id, i]));
	const height = PAD_Y * 2 + nodes.length * BOX_HEIGHT + Math.max(0, nodes.length - 1) * ROW_GAP;
	const centerX = CANVAS_WIDTH / 2;
	const boxX = centerX - BOX_WIDTH / 2;
	const boxRight = boxX + BOX_WIDTH;

	const boxes = nodes
		.map((n, i) => {
			const y = i * (BOX_HEIGHT + ROW_GAP) + PAD_Y;
			return `<rect x="${boxX}" y="${y}" width="${BOX_WIDTH}" height="${BOX_HEIGHT}" rx="12" fill="oklch(20% 0.02 165)" stroke="oklch(76% 0.17 155)" stroke-width="2"/><text x="${centerX}" y="${y + BOX_HEIGHT / 2}" text-anchor="middle" dominant-baseline="central" font-family="'Schibsted Grotesk', sans-serif" font-size="21" fill="oklch(93% 0.004 165)">${escapeSvgText(truncate(n.label, MAX_LABEL_CHARS))}</text>`;
		})
		.join('');

	const edgeMarkup = edges
		.map((e) => {
			const fromIdx = indexOf.get(e.from)!;
			const toIdx = indexOf.get(e.to)!;
			const fromY = nodeCenterY(fromIdx);
			const toY = nodeCenterY(toIdx);
			const labelSvg = e.label
				? `<text text-anchor="middle" font-family="'IBM Plex Mono', ui-monospace, monospace" font-size="16" fill="oklch(76% 0.17 155)"`
				: '';

			const isDirectForward = toIdx === fromIdx + 1;
			if (isDirectForward) {
				const y1 = fromY + BOX_HEIGHT / 2;
				const y2 = toY - BOX_HEIGHT / 2;
				const label = e.label
					? `${labelSvg} x="${centerX + 14}" y="${(y1 + y2) / 2}">${escapeSvgText(truncate(e.label, MAX_EDGE_LABEL_CHARS))}</text>`
					: '';
				return `<line x1="${centerX}" y1="${y1}" x2="${centerX}" y2="${y2}" stroke="oklch(76% 0.17 155)" stroke-width="2" marker-end="url(#slide-diagram-arrow)"/>${label}`;
			}

			const gap = Math.abs(toIdx - fromIdx);
			const bulge = boxRight + 36 + gap * 22;
			const label = e.label
				? `${labelSvg} x="${bulge + 6}" y="${(fromY + toY) / 2}">${escapeSvgText(truncate(e.label, MAX_EDGE_LABEL_CHARS))}</text>`
				: '';
			return `<path d="M ${boxRight},${fromY} C ${bulge},${fromY} ${bulge},${toY} ${boxRight},${toY}" fill="none" stroke="oklch(76% 0.17 155)" stroke-width="2" marker-end="url(#slide-diagram-arrow)"/>${label}`;
		})
		.join('');

	return `<svg viewBox="0 0 ${CANVAS_WIDTH} ${height}" width="100%" height="auto" role="img" aria-label="diagram" xmlns="http://www.w3.org/2000/svg"><defs><marker id="slide-diagram-arrow" markerWidth="9" markerHeight="9" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="oklch(76% 0.17 155)"/></marker></defs>${edgeMarkup}${boxes}</svg>`;
}
