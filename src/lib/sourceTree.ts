import type { LibraryNode } from './types';

/**
 * Reshapes the root of the tree per the vault's LibrarySettings
 * (hiddenFolders/flattenFolders, see library-read.ts's DEFAULT_SETTINGS) —
 * SourceTree.svelte's view-only concern, deliberately NOT applied to
 * LibraryTree.svelte's management view at /settings/library (that one
 * must keep showing everything, including the folders being hidden here).
 *
 * hiddenFolders entries are matched as PATH prefixes ("exact or subpath"),
 * the same semantics select-chunks.ts's isExcluded() already uses for the
 * very same setting — so one entry like "wiki/_index" now means the same
 * thing on both the display side and the retrieval side. Matching on
 * node.name instead (the original behaviour) could only ever address
 * root-level folders, which is why a nested one like wiki/_index was
 * unreachable. Bare names still work: "cards"/"raw"/"frontier" are root
 * folders whose path equals their name.
 *
 * Hiding is applied to a flattened folder's children too. Without that,
 * flattening was a hole straight through the filter: wiki/_index got
 * spliced into the root by flattenFolders: ['wiki'] having never been
 * offered to the hidden check at all.
 *
 * Still one level deep by design — a flattened folder's children are
 * spliced into the root as-is, not recursively re-flattened; that matches
 * the one real case this exists for (wiki/<domain>/... under a single
 * bookkeeping wrapper). Paths are untouched either way; this only changes
 * what the tree looks like, never what toggleNode/collectFilePaths/
 * toIncludedPaths operate on. */
export function applyDisplayRules(
	nodes: LibraryNode[],
	rules: { hiddenFolders: string[]; flattenFolders: string[] }
): LibraryNode[] {
	const isHidden = (node: LibraryNode) =>
		rules.hiddenFolders.some((h) => node.path === h || node.path.startsWith(`${h}/`));
	const flatten = new Set(rules.flattenFolders);
	const out: LibraryNode[] = [];
	for (const node of nodes) {
		if (node.type !== 'folder') {
			out.push(node);
			continue;
		}
		if (isHidden(node)) continue;
		if (flatten.has(node.name) || flatten.has(node.path)) {
			out.push(...(node.children ?? []).filter((child) => !isHidden(child)));
			continue;
		}
		out.push(node);
	}
	return out;
}

/** Recursively collects every file path under a node list — folders never
 * appear in the result, only their leaf files. Mirrors what select-chunks.ts's
 * inScope() actually matches on. */
export function collectFilePaths(nodes: LibraryNode[]): string[] {
	const out: string[] = [];
	for (const n of nodes) {
		if (n.type === 'file') out.push(n.path);
		else if (n.children) out.push(...collectFilePaths(n.children));
	}
	return out;
}

/** A file matches if its name contains the query; a folder matches if any
 * descendant file does — so a folder stays visible whenever it has to, and
 * disappears whenever it doesn't. */
export function nodeMatchesFilter(node: LibraryNode, query: string): boolean {
	if (!query) return true;
	const q = query.toLowerCase();
	if (node.type === 'file') return node.name.toLowerCase().includes(q);
	return (node.children ?? []).some((c) => nodeMatchesFilter(c, query));
}

export type TriState = 'checked' | 'unchecked' | 'indeterminate';

/** A file's state is a direct membership check; a folder's is derived from
 * how many of its descendant files are selected — never stored separately,
 * so it can never drift out of sync with the underlying file selection. */
export function nodeState(node: LibraryNode, selected: ReadonlySet<string>): TriState {
	if (node.type === 'file') return selected.has(node.path) ? 'checked' : 'unchecked';
	const files = collectFilePaths(node.children ?? []);
	if (files.length === 0) return 'unchecked';
	const selectedCount = files.filter((p) => selected.has(p)).length;
	if (selectedCount === 0) return 'unchecked';
	if (selectedCount === files.length) return 'checked';
	return 'indeterminate';
}

/** Toggling a file flips its membership; toggling a folder that isn't fully
 * selected selects every descendant file (indeterminate -> checked, the
 * standard tri-state convention), otherwise clears them all. Returns a new
 * Set — callers own the $state, this stays a pure function. */
export function toggleNode(node: LibraryNode, selected: ReadonlySet<string>): Set<string> {
	const next = new Set(selected);
	if (node.type === 'file') {
		if (next.has(node.path)) next.delete(node.path);
		else next.add(node.path);
		return next;
	}
	const files = collectFilePaths(node.children ?? []);
	const allSelected = files.length > 0 && files.every((p) => next.has(p));
	for (const f of files) {
		if (allSelected) next.delete(f);
		else next.add(f);
	}
	return next;
}

/** True when `path` is a descendant of the folder at `folderPath` — a
 * direct child or any depth further down, never the folder itself and never
 * a sibling that merely shares a name prefix (e.g. "wiki/mathematics/x.md"
 * is not inside "wiki/math"). Used by SourceTreeNode's "contains-lit" quiet
 * highlight: when the citation-highlighted file's row is collapsed away
 * inside a folder, the nearest visible collapsed ancestor(s) still show
 * that the target lives somewhere underneath. Both sides are already the
 * same library-root-relative, forward-slash path form (see
 * source-highlight.svelte.ts's doc comment), so no normalization step is
 * needed here. */
export function isPathInsideFolder(path: string, folderPath: string): boolean {
	return path.startsWith(`${folderPath}/`);
}

/** Faz 8's contract: includedPaths === undefined means "all" — never an
 * array listing every single file. Collapses a full selection back down to
 * that canonical "all" form so a chat that starts unscoped stays unscoped
 * in storage even after the tree round-trips through the UI. */
export function toIncludedPaths(selected: ReadonlySet<string>, allFiles: string[]): string[] | undefined {
	if (allFiles.every((p) => selected.has(p))) return undefined;
	return [...selected];
}
