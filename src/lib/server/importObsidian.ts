import path from 'node:path';
import { expandHome, indexKey, resolveSourceRoot, rewriteWikilinks, runImport, walkSource, type Indexer } from './library-import/common';
import { markdownFolderAdapter } from './library-import/markdown-folder';
import { protectedDirsFor } from './library-import/service';
import type { ImportResultItem, ImportSummary } from '#lib/types.js';
import type { VaultContext } from './vaults';

/**
 * The original Obsidian importer, now a thin wrapper: the generic parts moved
 * to library-import/common.ts and the Markdown behaviour to
 * library-import/markdown-folder.ts (shared with Zettlr, Foam, Dendron and
 * plain folders). Kept because scripts/sync-vault.ts and the old
 * /api/library/import-obsidian route call it as scan + run in one step, and
 * because its exported helpers have their own tests.
 */
export { expandHome, indexKey, rewriteWikilinks };

export async function importObsidianVault(
	v: VaultContext,
	sourcePath: string,
	onProgress?: (item: ImportResultItem) => void,
	opts: { protectedDirs?: string[]; indexer?: Indexer } = {}
): Promise<ImportSummary> {
	// path.resolve keeps the CLI's relative --source working; the route and the CLI
	// both end up at the same validated absolute root (symlink-resolved, not inside the app's own dirs).
	const root = resolveSourceRoot(path.resolve(expandHome(sourcePath)), opts.protectedDirs ?? protectedDirsFor(v));
	const plan = await markdownFolderAdapter.plan(root, walkSource(root));
	// Same contract as before: an empty folder is an empty result, not an error.
	return runImport(v, markdownFolderAdapter, plan, root, { onProgress, indexer: opts.indexer });
}
