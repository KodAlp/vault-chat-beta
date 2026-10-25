import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import type { LibraryNode, LibrarySettings } from '#lib/types.js';
import type { VaultContext } from './vaults';

const META_DIR = '_meta';

/**
 * A plain Error carrying the registry code, not an AppError: this module is also loaded by the MCP server, which must
 * not drag @sveltejs/kit in. toCodedError (app-error.ts) recognises a string `code` that is in the registry, so HTTP
 * routes still render the localized ServerErrors.PATH_OUTSIDE_LIBRARY; the message is a stable English log string.
 */
export class PathOutsideLibraryError extends Error {
	readonly code = 'PATH_OUTSIDE_LIBRARY' as const;
	constructor() {
		super('Path escapes the library root');
		this.name = 'PathOutsideLibraryError';
	}
}

const DEFAULT_SETTINGS: LibrarySettings = {
	// On by default: a kept original is what lets a note be re-imported later. A vault whose settings file
	// explicitly says false keeps false (the spread in getLibrarySettings only fills what is missing).
	keepOriginals: true,
	allowedLanguages: ['Türkçe'],
	responseLanguage: 'match',
	// Path prefixes, not just root names (see sourceTree.ts applyDisplayRules
	// and select-chunks.ts isExcluded — both use "exact or subpath"). wiki/_index
	// is the MOC/navigation layer: link lists, not study content, so it belongs
	// with cards/ and frontier/ rather than in front of the user as a source.
	hiddenFolders: ['raw', 'cards', 'frontier', 'notes', 'wiki/_index'],
	flattenFolders: ['wiki']
};

/**
 * Read-only leaf module: fs + path + gray-matter only, no incrementalIndex
 * import (unlike library.ts, which pulls in indexer/db.ts's write path
 * transitively). This is what the MCP server (mcp/) imports for get_note/
 * list_sources's traversal guard — importing library.ts instead would load
 * the write path into a process that must never touch it. See the
 * mcp-server skill.
 *
 * Also what makes resolveLibraryPath testable outside Vite at all — it
 * had no test before this split, since library.ts (via incrementalIndex.ts
 * -> ./ollama) couldn't be imported under plain tsx. Same reasoning
 * select-chunks.ts was split out of retrieve.ts for.
 */

/**
 * Security requirement from the source-ingest skill doc: every fs operation
 * on a user-supplied relative path resolves against the library root and
 * verifies the result is still inside it, before touching disk.
 *
 * Deliberately does NOT mkdirSync the root (unlike library.ts's writer-side
 * libraryRoot()) — this module is read-only, and creating directories as a
 * side effect of a read would be a surprising thing for an MCP server to do.
 */
export function resolveLibraryPath(v: VaultContext, relPath: string): string {
	const root = v.libraryRoot;
	const resolved = path.resolve(root, relPath);
	const withSep = root.endsWith(path.sep) ? root : root + path.sep;
	if (resolved !== root && !resolved.startsWith(withSep)) {
		throw new PathOutsideLibraryError();
	}
	return resolved;
}

function readNeedsReview(absPath: string): boolean {
	try {
		const raw = fs.readFileSync(absPath, 'utf-8');
		return matter(raw).data.needs_review === true;
	} catch {
		return false;
	}
}

function walkTree(absDir: string, relDir: string): LibraryNode[] {
	const entries = fs
		.readdirSync(absDir, { withFileTypes: true })
		.filter((e) => !e.name.startsWith('.') && e.name !== META_DIR)
		.sort((a, b) => a.name.localeCompare(b.name));

	const nodes: LibraryNode[] = [];
	for (const entry of entries) {
		const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
		const abs = path.join(absDir, entry.name);
		if (entry.isDirectory()) {
			nodes.push({ name: entry.name, path: rel, type: 'folder', children: walkTree(abs, rel) });
		} else if (entry.isFile() && entry.name.endsWith('.md')) {
			nodes.push({
				name: entry.name,
				path: rel,
				type: 'file',
				needsReview: readNeedsReview(abs)
			});
		}
	}
	return nodes;
}

/** Returns [] rather than throwing if the library root doesn't exist yet
 * (a brand-new vault, never written to) — the writer-side libraryRoot()
 * would mkdirSync it into existence, but this module never does that. */
export function getLibraryTree(v: VaultContext): LibraryNode[] {
	if (!fs.existsSync(v.libraryRoot)) return [];
	return walkTree(v.libraryRoot, '');
}

export function readLibraryFile(v: VaultContext, rel: string): string {
	return fs.readFileSync(resolveLibraryPath(v, rel), 'utf-8');
}

/** Exported (not module-private) so library.ts's writer-side
 * saveLibrarySettings() can target the same file without a second,
 * driftable copy of the path. */
export function settingsPath(v: VaultContext): string {
	return path.join(v.libraryRoot, META_DIR, 'settings.json');
}

/**
 * Moved here from library.ts (Part 3 of the source-tree/retrieval cleanup)
 * for the same reason getLibraryTree/readLibraryFile already live here:
 * retrieve.ts needs this to resolve LibrarySettings.hiddenFolders into
 * select-chunks.ts's excludedPrefixes, and retrieve.ts is imported by the
 * MCP server (mcp/tools/search-library.ts et al.) — pulling in library.ts
 * instead would drag incrementalIndex.ts's write path into a process that
 * must never touch it. See this module's own top-of-file doc comment.
 */
export function getLibrarySettings(v: VaultContext): LibrarySettings {
	try {
		const raw = fs.readFileSync(settingsPath(v), 'utf-8');
		return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<LibrarySettings>) };
	} catch {
		return { ...DEFAULT_SETTINGS };
	}
}
