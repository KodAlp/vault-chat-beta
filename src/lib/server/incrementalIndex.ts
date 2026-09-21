import crypto from 'node:crypto';
import fs from 'node:fs';
import { openDb, upsertFile, deleteFile, renameFileInIndex, type FileRow } from '../../../indexer/db';
import { chunkMarkdown, normalizeLevel } from '../../../indexer/chunk';
import { parsePrerequisites } from '../../../indexer/prerequisites';
import { embed } from './ollama';
import { EMBED_MODEL, DOC_PREFIX } from './embed-config';
import type { VaultContext } from './vaults';

const BATCH_SIZE = 32;

/**
 * Mirrors indexer/embed.ts's batching (same DOC_PREFIX, same batch size) but
 * calls the app's own SvelteKit-env-aware embed() from ./ollama instead of
 * indexer/ollama-client.ts — that second client exists specifically so the
 * standalone `npm run index` CLI doesn't need $env/dynamic. Two runtimes,
 * two thin clients; not worth entangling for ~10 shared lines.
 */
async function embedDocuments(texts: string[]): Promise<number[][]> {
	const results: number[][] = [];
	for (let i = 0; i < texts.length; i += BATCH_SIZE) {
		const batch = texts.slice(i, i + BATCH_SIZE).map((t) => `${DOC_PREFIX}${t}`);
		const vectors = await embed(batch, EMBED_MODEL);
		results.push(...vectors);
	}
	return results;
}

function sha256(content: string): string {
	return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Indexes (or re-indexes) a single library file immediately — used by the
 * upload/import flows so a new document is retrievable right away, without
 * waiting for a full `npm run index` pass over the whole library.
 */
export async function indexLibraryFile(v: VaultContext, absPath: string, relPath: string): Promise<void> {
	const raw = fs.readFileSync(absPath, 'utf-8');
	const { frontmatter, chunks } = chunkMarkdown(raw);
	if (chunks.length === 0) return;

	const embeddings = await embedDocuments(chunks.map((c) => c.embedText));
	const db = openDb(v.indexDbPath);
	try {
		const fileRow: FileRow = {
			path: relPath,
			sha256: sha256(raw),
			mtime: fs.statSync(absPath).mtimeMs,
			topic: frontmatter.title ?? frontmatter.topic ?? '',
			depth: normalizeLevel(frontmatter.level ?? frontmatter.depth ?? ''),
			domains_json: JSON.stringify(
				frontmatter.domains ?? (frontmatter.domain ? [frontmatter.domain] : [])
			),
			prerequisites_json: JSON.stringify(parsePrerequisites(frontmatter.prerequisites))
		};
		upsertFile(
			db,
			fileRow,
			chunks.map((c, i) => ({
				insert: { path: relPath, heading_path: c.headingPath, display_text: c.displayText },
				embedding: embeddings[i]
			}))
		);
	} finally {
		db.close();
	}
}

export function removeLibraryFileFromIndex(v: VaultContext, relPath: string): void {
	const db = openDb(v.indexDbPath);
	try {
		deleteFile(db, relPath);
	} finally {
		db.close();
	}
}

export function renameLibraryFileInIndex(v: VaultContext, oldRelPath: string, newRelPath: string): void {
	const db = openDb(v.indexDbPath);
	try {
		renameFileInIndex(db, oldRelPath, newRelPath);
	} finally {
		db.close();
	}
}
