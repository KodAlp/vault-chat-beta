import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { env } from '$env/dynamic/private';
import { openDb, upsertFile, deleteFile, renameFileInIndex, type FileRow } from '../../../indexer/db';
import { chunkMarkdown } from '../../../indexer/chunk';
import { embed } from './ollama';
import { EMBED_MODEL, DOC_PREFIX } from './embed-config';

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

function dbPath(): string {
	return path.resolve(process.cwd(), env.INDEX_DB_PATH ?? path.join('data', 'vault-index.db'));
}

function sha256(content: string): string {
	return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Indexes (or re-indexes) a single library file immediately — used by the
 * upload/import flows so a new document is retrievable right away, without
 * waiting for a full `npm run index` pass over the whole library.
 */
export async function indexLibraryFile(absPath: string, relPath: string): Promise<void> {
	const raw = fs.readFileSync(absPath, 'utf-8');
	const { frontmatter, chunks } = chunkMarkdown(raw);
	if (chunks.length === 0) return;

	const embeddings = await embedDocuments(chunks.map((c) => c.embedText));
	const db = openDb(dbPath());
	try {
		const fileRow: FileRow = {
			path: relPath,
			sha256: sha256(raw),
			mtime: fs.statSync(absPath).mtimeMs,
			topic: frontmatter.title ?? frontmatter.topic ?? '',
			depth: frontmatter.level ?? frontmatter.depth ?? '',
			domains_json: JSON.stringify(
				frontmatter.domains ?? (frontmatter.domain ? [frontmatter.domain] : [])
			)
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

export function removeLibraryFileFromIndex(relPath: string): void {
	const db = openDb(dbPath());
	try {
		deleteFile(db, relPath);
	} finally {
		db.close();
	}
}

export function renameLibraryFileInIndex(oldRelPath: string, newRelPath: string): void {
	const db = openDb(dbPath());
	try {
		renameFileInIndex(db, oldRelPath, newRelPath);
	} finally {
		db.close();
	}
}
