import type { LibraryNode } from './types';

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

/** Faz 8's contract: includedPaths === undefined means "all" — never an
 * array listing every single file. Collapses a full selection back down to
 * that canonical "all" form so a chat that starts unscoped stays unscoped
 * in storage even after the tree round-trips through the UI. */
export function toIncludedPaths(selected: ReadonlySet<string>, allFiles: string[]): string[] | undefined {
	if (allFiles.every((p) => selected.has(p))) return undefined;
	return [...selected];
}
