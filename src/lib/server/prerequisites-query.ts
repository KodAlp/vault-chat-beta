import type Database from 'better-sqlite3';
import {
	buildSlugIndex,
	findCycles,
	resolvePrerequisites,
	transitivePrerequisites,
	type ResolvedPrerequisites
} from '../../../indexer/prerequisites';

/**
 * Reads the prerequisite graph out of the index. The names are stored as written in the note's
 * frontmatter and turned into paths HERE, on every read, so a note added, renamed or moved after
 * its dependants were indexed is picked up without touching them (indexer/prerequisites.ts).
 *
 * Takes a Database like keyword-search.ts does, so it works with the app's read-only handle and with
 * `:memory:` in tests. The app cannot add the column itself (it opens the index read-only), and an index
 * built before the prerequisite column does not have it until `npm run index -- --prereqs`: every function returns `null` in
 * that case, which is NOT the same as "this note has no prerequisites" — callers should say the index needs
 * refreshing, not that the graph is empty.
 */

/** Whether this index has the prerequisite column at all. False for one built before the prerequisite column. */
export function hasPrerequisitesColumn(db: Database.Database): boolean {
	return (db.prepare('PRAGMA table_info(files)').all() as { name: string }[]).some((c) => c.name === 'prerequisites_json');
}

export interface PrerequisiteGraph {
	/** path -> the paths it requires, only the names that resolved to exactly one file. */
	edges: Map<string, string[]>;
	/** path -> names that matched no file / more than one file (for a "broken link" report). */
	unresolved: Map<string, string[]>;
	ambiguous: Map<string, string[]>;
}

function parseNames(json: string): string[] {
	try {
		const v: unknown = JSON.parse(json);
		return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
	} catch {
		return []; // a corrupt cell is "no prerequisites", never a thrown error in the middle of a chat
	}
}

/** The whole graph (a few hundred rows), or null when the index has no prerequisite column. */
export function loadPrerequisiteGraph(db: Database.Database): PrerequisiteGraph | null {
	if (!hasPrerequisitesColumn(db)) return null;
	const rows = db.prepare('SELECT path, prerequisites_json FROM files').all() as { path: string; prerequisites_json: string }[];
	const index = buildSlugIndex(rows.map((r) => r.path));
	const graph: PrerequisiteGraph = { edges: new Map(), unresolved: new Map(), ambiguous: new Map() };
	for (const row of rows) {
		const r = resolvePrerequisites(parseNames(row.prerequisites_json), index);
		graph.edges.set(row.path, r.resolved);
		if (r.unresolved.length > 0) graph.unresolved.set(row.path, r.unresolved);
		if (r.ambiguous.length > 0) graph.ambiguous.set(row.path, r.ambiguous);
	}
	return graph;
}

/** What one note requires directly, split into resolved / unresolved / ambiguous; null without the column. */
export function getPrerequisites(db: Database.Database, path: string): ResolvedPrerequisites | null {
	if (!hasPrerequisitesColumn(db)) return null;
	const rows = db.prepare('SELECT path, prerequisites_json FROM files').all() as { path: string; prerequisites_json: string }[];
	const row = rows.find((r) => r.path === path);
	if (!row) return { resolved: [], unresolved: [], ambiguous: [] };
	return resolvePrerequisites(parseNames(row.prerequisites_json), buildSlugIndex(rows.map((r) => r.path)));
}

/** Everything `path` needs, directly or transitively, nearest first, safe on a cycle; null without the column. */
export function getPrerequisiteChain(db: Database.Database, path: string): string[] | null {
	const graph = loadPrerequisiteGraph(db);
	return graph ? transitivePrerequisites(path, graph.edges) : null;
}

/** Cycles in the prerequisite graph ("A needs B needs A"); null without the column. */
export function findPrerequisiteCycles(db: Database.Database): string[][] | null {
	const graph = loadPrerequisiteGraph(db);
	return graph ? findCycles(graph.edges) : null;
}
