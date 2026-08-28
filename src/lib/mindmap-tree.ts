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
 *   (synthesized automatically as citation-less structural nodes)
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
	return root;
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
