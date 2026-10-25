import crypto from 'node:crypto';
import fs from 'node:fs';
import { hasSqliteVec } from './sqlite-vec-loader';
import { openDb, upsertFile, deleteFile, renameFileInIndex, readIndexEmbedding, markIndexFtsOnly, embeddingMismatches, type FileRow, type IndexEmbeddingMeta } from '../../../indexer/db';
import { chunkMarkdown, normalizeLevel } from '../../../indexer/chunk';
import { parsePrerequisites } from '../../../indexer/prerequisites';
import { embedTexts } from './embeddings';
import { DOC_PREFIX } from './embed-config';
import { getEmbeddingConfig } from './providers/config-store';
import { AppError } from './app-error';
import { isReindexing } from './reindex';
import { scheduleConvertedImageSweep } from './converted-image-cleanup';
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

/**
 * Indexes (or re-indexes) a single library file immediately — used by the
 * upload/import flows so a new document is retrievable right away, without
 * waiting for a full `npm run index` pass over the whole library.
 */
export async function indexLibraryFile(v: VaultContext, absPath: string, relPath: string): Promise<void> {
	// A reindex (POST /api/vaults/[id]/reindex, reindex.ts) builds a
	// brand-new index.db in a temp file and then swaps it over this vault's
	// real one — a write landing here mid-rebuild would go into the OLD file
	// right before it's replaced (silently lost) or race the swap itself.
	// Refuse outright rather than queue: the user is actively waiting on the
	// reindex, and a lost upload is worse than having to retry it once done.
	if (isReindexing(v.id)) throw new AppError('REINDEX_IN_PROGRESS', undefined, 409);

	const raw = fs.readFileSync(absPath, 'utf-8');
	const { frontmatter, chunks } = chunkMarkdown(raw);
	if (chunks.length === 0) return;

	const config = getEmbeddingConfig();
	// null config = FTS-only mode: chunks + keyword data are written, vectors are not.
	const embeddingMeta: IndexEmbeddingMeta | null = config
		? { provider: config.providerId, model: config.model, dims: config.dims }
		: null;
	const db = openDb(v.indexDbPath, embeddingMeta);
	try {
		// Refuse to write vectors from the CURRENT config into an
		// index whose vec_chunks table was baked with a different dimension
		// (or was, per index_meta, built with a different provider/model) —
		// the dimension is fixed in that table's DDL, so a silent write here
		// would either fail at the SQLite level (dimension mismatch) or,
		// worse, "succeed" while mixing two incompatible vector spaces in one
		// table. The user must run a full reindex (`npm run index -- --vault
		// <id> --full`, or the app's own POST /api/vaults/[id]/reindex, Aşama
		// 3b) before this config can take effect for this vault.
		const existing = readIndexEmbedding(db);
		// No sqlite-vec on this machine: write FTS-only, same as an unconfigured embedding.
		const wantsVectors = embeddingMeta !== null && hasSqliteVec(db);
		if (embeddingMeta && wantsVectors && embeddingMismatches(existing, config)) {
			throw new AppError('EMBEDDING_MISMATCH', {
				detail: `index: ${existing.provider}/${existing.model}/${existing.dims} != config: ${embeddingMeta.provider}/${embeddingMeta.model}/${embeddingMeta.dims}`
			});
		}

		// FTS-only: never refuse and never embed. If the index still claims real vectors, stop claiming it
		// once a chunk is written without one (see markIndexFtsOnly).
		const embeddings = wantsVectors ? await embedDocuments(chunks.map((c) => c.embedText)) : null;
		if (!wantsVectors) markIndexFtsOnly(db);
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
				embedding: embeddings ? embeddings[i] : null
			}))
		);
	} finally {
		db.close();
	}
	// Library content just changed: let the (throttled, off-request-path) orphan-image sweep look at this vault.
	scheduleConvertedImageSweep(v);
}

export function removeLibraryFileFromIndex(v: VaultContext, relPath: string): void {
	if (isReindexing(v.id)) throw new AppError('REINDEX_IN_PROGRESS', undefined, 409);
	const db = openDb(v.indexDbPath);
	try {
		deleteFile(db, relPath);
	} finally {
		db.close();
	}
}

export function renameLibraryFileInIndex(v: VaultContext, oldRelPath: string, newRelPath: string): void {
	if (isReindexing(v.id)) throw new AppError('REINDEX_IN_PROGRESS', undefined, 409);
	const db = openDb(v.indexDbPath);
	try {
		renameFileInIndex(db, oldRelPath, newRelPath);
	} finally {
		db.close();
	}
}
