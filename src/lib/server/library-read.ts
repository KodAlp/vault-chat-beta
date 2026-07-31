import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import type { LibraryNode } from '$lib/types';
import type { VaultContext } from './vaults';

const META_DIR = '_meta';

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
		throw new Error('Geçersiz yol (library dışına çıkıyor)');
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
