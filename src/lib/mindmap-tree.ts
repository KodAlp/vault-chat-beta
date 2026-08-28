export interface MindMapTreeNode {
	label: string;
	/** One sentence saying what this node MEANS. Empty for nodes stored before
	 * summaries existed, and for structural nodes buildTree had to synthesize. */
	summary: string;
	sourcePath: string | null;
	headingPath: string | null;
	children: MindMapTreeNode[];
}

export interface MindMapRootInput {
	label: string;
	summary: string;
}

/**
 * Assembles the nested tree the view renders from the flattened
 * `{path, summary, source_path, heading_path}[]` rows in study.db.
 *
 * The model itself now emits a nested tree (see mindmap-schema.ts); the
 * flattening to `path` arrays happens server-side purely so the existing
 * mindmap_nodes table shape survives. This rebuilds it, and still handles the
 * two cases the stored rows can present:
 * - several rows describing the same branch (merged by label per level)
 * - a deep path whose ancestors have no row of their own (synthesized here,
 *   then given a citation by backfillCitations)
 *
 * The root is a REAL node now, carrying the topic and its definition. It used
 * to be a bare title that treeToMarkdownOutline skipped entirely, which is why
 * the rendered map began with an empty, unlabelled circle.
 */
export function buildTree(
	root: MindMapRootInput,
	nodes: { path: string[]; summary: string; source_path: string; heading_path: string }[]
): MindMapTreeNode {
	const tree: MindMapTreeNode = {
		label: root.label,
		summary: root.summary,
		sourcePath: null,
		headingPath: null,
		children: []
	};
	for (const node of nodes) {
		let cursor = tree;
		for (const label of node.path) {
			let child = cursor.children.find((c) => c.label === label);
			if (!child) {
				child = { label, summary: '', sourcePath: null, headingPath: null, children: [] };
				cursor.children.push(child);
			}
			cursor = child;
		}
		cursor.summary = node.summary;
		cursor.sourcePath = node.source_path;
		cursor.headingPath = node.heading_path;
	}
	for (const child of tree.children) backfillCitations(child);
	return tree;
}

/**
 * Gives every node a citation by inheriting from its first cited descendant
 * (depth-first, left to right).
 *
 * A node the model never emitted a row for is synthesized above with
 * sourcePath null, which made branch nodes the only things in the map that did
 * nothing when clicked — that reads as broken, not as a deliberate
 * distinction. Inheriting downward is honest: a branch is a grouping OF its
 * descendants, so its first descendant's source is genuinely where it came
 * from. Never an invented citation.
 *
 * The root is excluded (callers pass tree.children): it is the topic itself,
 * not a claim quoted from one chunk.
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

/** `[` and `]` would prematurely close the `[label](url)` span, and heading
 * text from a book can plausibly contain either ("Diziler [Bölüm 3]"). */
function escapeBrackets(text: string): string {
	return text.replace(/[[\]]/g, '\\$&');
}

/**
 * markmap-lib builds its markdown-it with `html: true`, so anything that looks
 * like a tag in this outline is rendered as real markup. Model-produced labels
 * and summaries go straight into it, so they are escaped — this is not
 * decoration, it closes a hole that was already open before the wrapper spans
 * below were introduced.
 */
function escapeHtml(text: string): string {
	return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Both escapes, in the order that keeps them independent: HTML first (so the
 * backslashes markdown needs are not themselves escaped), brackets second. */
function safeText(text: string): string {
	return escapeBrackets(escapeHtml(text));
}

/**
 * How much of a long explanation is shown before it is cut with an ellipsis.
 * Summaries are capped at 450 characters server-side (mindmap-validate.ts), so
 * this shows roughly the first third — enough to tell what the node is about,
 * short enough that a branch of them stays readable.
 */
const SUMMARY_PREVIEW_CHARS = 140;

/** Cuts at a word boundary, never mid-word, and only when there is enough left
 * over to be worth hiding. */
function previewOf(text: string): string | null {
	if (text.length <= SUMMARY_PREVIEW_CHARS) return null;
	const slice = text.slice(0, SUMMARY_PREVIEW_CHARS);
	const lastSpace = slice.lastIndexOf(' ');
	const cut = lastSpace > SUMMARY_PREVIEW_CHARS * 0.6 ? slice.slice(0, lastSpace) : slice;
	return `${cut.trimEnd()}…`;
}

/**
 * A summary rendered as markmap node content.
 *
 * Short ones are a single span. Long ones ship BOTH the preview and the full
 * text, with one of them hidden by CSS — deliberately not a CSS clamp
 * (`-webkit-line-clamp`, `max-height` + `overflow:hidden`). markmap re-measures
 * every node on each render by reading the content's `scrollWidth`/
 * `scrollHeight`, and a clipped element still reports its FULL scroll size, so
 * a clamped node would reserve space for text nobody can see and blow a hole in
 * the layout. `display: none` contributes nothing to scroll size, so whichever
 * variant is visible is exactly what gets measured.
 *
 * The view route toggles `is-clamped` on click and calls renderData() to
 * re-measure — see study/mindmap/[id]/+page.svelte.
 */
function summaryMarkup(summary: string): string {
	const preview = previewOf(summary);
	if (!preview) return `<span class="mm-summary">${safeText(summary)}</span>`;
	return (
		'<span class="mm-summary is-clamped">' +
		`<span class="mm-short">${safeText(preview)}</span>` +
		`<span class="mm-full">${safeText(summary)}</span>` +
		'</span>'
	);
}

/**
 * Markmap's Transformer consumes a markdown string, not a node object — this
 * is the seam between buildTree()'s output and markmap-lib. Nodes render
 * through markmap-view's foreignObject/HTML path, so a markdown link here
 * becomes a real `<a>` inside the SVG.
 *
 * Layout per concept, which is the user's requirement expressed in markmap's
 * own terms rather than with custom click handling:
 *
 *     - Türev                          <- the topic
 *       - anlık değişim oranı          <- what it means
 *       - Kısmi türevler               <- a sub-area
 *         - çok değişkenli ...         <- what THAT means
 *           - [Kaynağı aç](/library/…) <- and under the explanation, its source
 *         - Zincir kuralı              <- the sub-area's own children
 *
 * Putting the summary and the link in the tree means markmap's built-in
 * collapse/expand (click a node's circle) already does "tap a node to see its
 * explanation" — no click plumbing of our own, and it keeps working with
 * markmap's pan/zoom, keyboard and animation behaviour for free.
 *
 * The link hangs off the SUMMARY rather than off the concept so that
 * collapsing a concept hides its explanation and its citation together, and
 * so the citation reads as belonging to the explanation it backs.
 *
 * `linkFor` stays optional and per-node: returning null leaves a node with no
 * citation line at all.
 */
export function treeToMarkdownOutline(
	tree: MindMapTreeNode,
	linkFor?: (node: MindMapTreeNode) => string | null,
	linkLabel = 'Kaynağı aç'
): string {
	const lines: string[] = [];
	const push = (depth: number, text: string) => lines.push(`${'  '.repeat(depth)}- ${text}`);

	function walk(node: MindMapTreeNode, depth: number) {
		push(depth, safeText(node.label));

		const url = linkFor?.(node) ?? null;
		if (node.summary) {
			push(depth + 1, summaryMarkup(node.summary));
			if (url) push(depth + 2, `[${linkLabel}](${url})`);
		} else if (url) {
			// No explanation to hang it on — the citation still belongs somewhere.
			push(depth + 1, `[${linkLabel}](${url})`);
		}

		for (const child of node.children) walk(child, depth + 1);
	}

	walk(tree, 0);
	return lines.join('\n');
}
