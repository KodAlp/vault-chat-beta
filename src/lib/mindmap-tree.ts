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
 * markmap-lib's Transformer.transform(). Node labels stay plain text (no
 * embedded links — see mindmap generator's view route for why). */
export function treeToMarkdownOutline(tree: MindMapTreeNode): string {
	const lines: string[] = [];
	function walk(node: MindMapTreeNode, depth: number) {
		lines.push(`${'  '.repeat(depth)}- ${node.label}`);
		for (const child of node.children) walk(child, depth + 1);
	}
	for (const child of tree.children) walk(child, 0);
	return lines.join('\n');
}
