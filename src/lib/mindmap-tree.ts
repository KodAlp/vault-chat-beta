export interface MindMapTreeNode {
	label: string;
	sourcePath: string | null;
	headingPath: string | null;
	children: MindMapTreeNode[];
}

/**
 * Assembles a nested tree from the model's flat `{path, source_path,
 * heading_path}[]` output (see mindmap-schema.ts — the model is never asked
 * for a recursive/nested shape directly, only a flat array, which is a much
 * safer structured-output target). Handles the two failure modes schema
 * validation alone can't catch:
 * - duplicate paths describing the same branch (merged by label match per
 *   level, last writer wins on the citation)
 * - orphaned deep paths whose ancestors were never separately emitted
 *   (synthesized automatically, then given a citation by backfillCitations)
 */
export function buildTree(
	title: string,
	nodes: { path: string[]; source_path: string; heading_path: string }[]
): MindMapTreeNode {
	const root: MindMapTreeNode = { label: title, sourcePath: null, headingPath: null, children: [] };
	for (const node of nodes) {
		let cursor = root;
		for (const label of node.path) {
			let child = cursor.children.find((c) => c.label === label);
			if (!child) {
				child = { label, sourcePath: null, headingPath: null, children: [] };
				cursor.children.push(child);
			}
			cursor = child;
		}
		cursor.sourcePath = node.source_path;
		cursor.headingPath = node.heading_path;
	}
	for (const child of root.children) backfillCitations(child);
	return root;
}

/**
 * Gives every node a citation by inheriting from its first cited descendant
 * (depth-first, left to right).
 *
 * The model only ever cites the nodes it actually emitted, which are the
 * leaves of each emitted path. Every ancestor along the way is synthesized
 * by buildTree above and had sourcePath null — so in the rendered map the
 * branch nodes ("Process Scheduling: Policies and Mechanisms", a book title,
 * anything with children) were the ONLY things not clickable, which reads as
 * broken rather than as a deliberate distinction. Inheriting downward is the
 * honest answer: a branch is a grouping OF its descendants, so its first
 * descendant's source is genuinely where that branch came from — never an
 * invented citation.
 *
 * The root is excluded (callers pass root.children): its label is the map
 * title, not content, and treeToMarkdownOutline never renders it anyway.
 */
function backfillCitations(node: MindMapTreeNode): MindMapTreeNode | null {
	let firstCited: MindMapTreeNode | null = node.sourcePath ? node : null;
	for (const child of node.children) {
		const cited = backfillCitations(child);
		if (!firstCited && cited) firstCited = cited;
	}
	if (!node.sourcePath && firstCited) {
		node.sourcePath = firstCited.sourcePath;
		node.headingPath = firstCited.headingPath;
	}
	return node.sourcePath ? node : null;
}

/** Markmap's Transformer consumes a markdown string, not a hand-built node
 * object — this is the integration seam between buildTree()'s output and
 * markmap-lib's Transformer.transform(). Nodes render through markmap-view's
 * foreignObject/HTML path (see its `.markmap-foreign a` style), so a real
 * markdown link here becomes a real clickable `<a>` in the SVG — no extra
 * wiring needed on the view side beyond passing `linkFor`.
 *
 * `linkFor` is optional and per-node: it's asked for every node (not just
 * leaves), so a caller can choose to link only cited nodes (sourcePath !==
 * null) by returning null for the rest — those stay plain text, exactly as
 * before this was introduced. `]` in a label is escaped since it would
 * otherwise prematurely close the `[label]` span of the markdown link
 * syntax (its unescaped counterpart `[` is escaped too, for the same
 * reason); heading text from a book/course source can plausibly contain
 * either (e.g. "Diziler [Bölüm 3]"). */
export function treeToMarkdownOutline(
	tree: MindMapTreeNode,
	linkFor?: (node: MindMapTreeNode) => string | null
): string {
	const lines: string[] = [];
	function walk(node: MindMapTreeNode, depth: number) {
		const url = linkFor?.(node) ?? null;
		const text = url ? `[${node.label.replace(/[[\]]/g, '\\$&')}](${url})` : node.label;
		lines.push(`${'  '.repeat(depth)}- ${text}`);
		for (const child of node.children) walk(child, depth + 1);
	}
	for (const child of tree.children) walk(child, 0);
	return lines.join('\n');
}
