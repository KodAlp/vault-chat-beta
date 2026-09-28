import crypto from 'node:crypto';
import fs from 'node:fs';
import { openDb, upsertFile, deleteFile, renameFileInIndex, readIndexEmbedding, type FileRow, type IndexEmbeddingMeta } from '../../../indexer/db';
import { chunkMarkdown, normalizeLevel } from '../../../indexer/chunk';
import { parsePrerequisites } from '../../../indexer/prerequisites';
import { embedTexts } from './embeddings';
import { DOC_PREFIX } from './embed-config';
import { getEmbeddingConfig } from './providers/config-store';
import { AppError } from './app-error';
import type { VaultContext } from './vaults';

/** Mirrors indexer/index-vault.ts's own batching call — embedTexts() already
 * batches internally (embeddings.ts, BATCH_SIZE 32), so this is purely
 * DOC_PREFIX prepending (embed-config.ts; '' for bge-m3 today, see that
 * file's doc comment) before handing off to the single embed path. */
async function embedDocuments(texts: string[]): Promise<number[][]> {
	return embedTexts(
		texts.map((t) => `${DOC_PREFIX}${t}`),
		{ purpose: 'document' }
	);
}

function sha256(content: string): string {
	return crypto.createHash('sha256').update(content).digest('hex');
}

function metaMatches(a: IndexEmbeddingMeta, b: IndexEmbeddingMeta): boolean {
	return a.provider === b.provider && a.model === b.model && a.dims === b.dims;
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

	const config = getEmbeddingConfig();
	const embeddingMeta: IndexEmbeddingMeta = { provider: config.providerId, model: config.model, dims: config.dims };
	const db = openDb(v.indexDbPath, embeddingMeta);
	try {
		// Aşama 3a: refuse to write vectors from the CURRENT config into an
		// index whose vec_chunks table was baked with a different dimension
		// (or was, per index_meta, built with a different provider/model) —
		// the dimension is fixed in that table's DDL, so a silent write here
		// would either fail at the SQLite level (dimension mismatch) or,
		// worse, "succeed" while mixing two incompatible vector spaces in one
		// table. The user must run a full reindex (`npm run index -- --vault
		// <id> --full`, or the app's own reindex action once Aşama 3b ships)
		// before this config can take effect for this vault.
		const existing = readIndexEmbedding(db);
		if (!metaMatches(existing, embeddingMeta)) {
			throw new AppError('EMBEDDING_MISMATCH', {
				detail: `index: ${existing.provider}/${existing.model}/${existing.dims} != config: ${embeddingMeta.provider}/${embeddingMeta.model}/${embeddingMeta.dims}`
			});
		}

		const embeddings = await embedDocuments(chunks.map((c) => c.embedText));
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
