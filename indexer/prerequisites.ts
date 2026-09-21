/**
 * Prerequisite links between notes (F4). Pure and dependency-free, so both the
 * indexer CLI and the app can use it and `tsx --test` can run it.
 *
 * Frontmatter says `prerequisites: ['[[online-algorithms]]', '[[np-completeness]]']`
 * — wikilinks, not paths. On the real vault (default, 467 notes) 258 notes have a
 * non-empty list, all 432 references are wikilinks, and every one resolves to exactly
 * one file by file name, with no cycles. That is what this module relies on and what
 * it reports honestly when it stops holding: an unresolved or ambiguous name is
 * returned as such, never guessed.
 *
 * What is stored is the link TARGET NAME as written ("online-algorithms"), not a
 * path. Resolving to a path happens when the graph is read, so a note that is added,
 * renamed or moved later is picked up without re-indexing the notes that point at it.
 */

/**
 * The link targets in a frontmatter `prerequisites` value, in order, without duplicates.
 *
 * gray-matter hands back whatever YAML produced, and YAML is forgiving in ways that
 * matter here: an unquoted `- [[x]]` is a NESTED ARRAY (`[['x']]`), not a string, so
 * arrays are flattened; a scalar string is accepted as a one-item list; numbers, nulls
 * and objects are ignored rather than crashing the indexer over one badly written note.
 */
export function parsePrerequisites(raw: unknown): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	const add = (name: string) => {
		const target = cleanTarget(name);
		if (!target) return;
		const key = slugKey(target);
		if (seen.has(key)) return;
		seen.add(key);
		out.push(target);
	};
	const visit = (v: unknown): void => {
		if (Array.isArray(v)) {
			v.forEach(visit);
			return;
		}
		if (typeof v !== 'string') return;
		const links = [...v.matchAll(/\[\[([^\]]+)\]\]/g)];
		if (links.length > 0) links.forEach((m) => add(m[1]));
		else v.split(',').forEach(add); // a bare "a, b" string
	};
	visit(raw);
	return out;
}

/** `Note|alias`, `Note#Heading`, `folder/Note`, `Note.md` all mean the note called `Note`. */
function cleanTarget(s: string): string {
	let t = s.normalize('NFC').trim();
	t = t.split('|')[0].split('#')[0].trim();
	t = t.replace(/^.*\//, '').replace(/\.md$/i, '').trim();
	return t;
}

/** Obsidian resolves links case-insensitively; so does this. */
export function slugKey(name: string): string {
	return name.normalize('NFC').trim().toLowerCase();
}

/** `wiki/algorithms/np-completeness.md` -> `np-completeness`. */
export function slugOfPath(path: string): string {
	return slugKey(path.replace(/^.*\//, '').replace(/\.md$/i, ''));
}

/** File name -> every path with that name (two notes can share a name in different folders). */
export function buildSlugIndex(paths: Iterable<string>): Map<string, string[]> {
	const index = new Map<string, string[]>();
	for (const p of paths) {
		const key = slugOfPath(p);
		const list = index.get(key);
		if (list) list.push(p);
		else index.set(key, [p]);
	}
	return index;
}

export interface ResolvedPrerequisites {
	/** One path per name that matched exactly one file, in the order written. */
	resolved: string[];
	/** Names that match no file (a stub not written yet, a typo, a deleted note). */
	unresolved: string[];
	/** Names that match more than one file — reported, not guessed. */
	ambiguous: string[];
}

export function resolvePrerequisites(names: readonly string[], index: Map<string, string[]>): ResolvedPrerequisites {
	const result: ResolvedPrerequisites = { resolved: [], unresolved: [], ambiguous: [] };
	for (const name of names) {
		const matches = index.get(slugKey(name)) ?? [];
		if (matches.length === 1) result.resolved.push(matches[0]);
		else if (matches.length === 0) result.unresolved.push(name);
		else result.ambiguous.push(name);
	}
	return result;
}

/**
 * Every cycle reachable in a prerequisite graph (`graph.get(a)` = what `a` requires),
 * each as the list of nodes around the loop starting at where it was closed. A cycle
 * means "A needs B needs A": a learning path built on it never terminates, so callers
 * that walk the graph must handle it rather than assume a DAG. Empty when there is none.
 */
export function findCycles(graph: ReadonlyMap<string, readonly string[]>): string[][] {
	const cycles: string[][] = [];
	const state = new Map<string, 1 | 2>(); // 1 = on the current path, 2 = fully explored
	const path: string[] = [];
	const visit = (node: string): void => {
		state.set(node, 1);
		path.push(node);
		for (const next of graph.get(node) ?? []) {
			const s = state.get(next);
			if (s === 1) cycles.push(path.slice(path.indexOf(next)));
			else if (s === undefined) visit(next);
		}
		path.pop();
		state.set(node, 2);
	};
	for (const node of graph.keys()) if (!state.has(node)) visit(node);
	return cycles;
}

/**
 * Everything `path` needs, directly or through other prerequisites, nearest first, without
 * repeats and without looping on a cycle. `path` itself is never included.
 */
export function transitivePrerequisites(path: string, graph: ReadonlyMap<string, readonly string[]>): string[] {
	const out: string[] = [];
	const seen = new Set<string>([path]);
	let frontier = [path];
	while (frontier.length > 0) {
		const next: string[] = [];
		for (const node of frontier) {
			for (const dep of graph.get(node) ?? []) {
				if (seen.has(dep)) continue;
				seen.add(dep);
				out.push(dep);
				next.push(dep);
			}
		}
		frontier = next;
	}
	return out;
}
