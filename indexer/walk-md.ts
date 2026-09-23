import fs from 'node:fs';
import path from 'node:path';
import { EXCLUDED_DIRS } from './excluded-dirs';

/**
 * Every `.md` file under `dir`, skipping EXCLUDED_DIRS at any depth — the
 * exact file set `npm run index` walks (was a local, unexported function
 * inside index-vault.ts). Shared so "how many files could be indexed" (the
 * unindexed-file signal in list_vaults and the library UI, Ö2/E2 from the
 * 2026-09-23 report — a kürasyon batch that finished but was never followed
 * by `npm run index` looked identical to one that had been) can never
 * silently drift from what index-vault.ts itself actually walks.
 *
 * Pure fs + path, no other project import — safe from both the standalone
 * indexer CLI and src/lib/server/ (SvelteKit + the MCP server), matching
 * chunk.ts's own leaf-module convention.
 */
export function walkMarkdownFiles(dir: string, out: string[] = []): string[] {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (EXCLUDED_DIRS.has(entry.name)) continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) walkMarkdownFiles(full, out);
		else if (entry.isFile() && entry.name.endsWith('.md')) out.push(full);
	}
	return out;
}
