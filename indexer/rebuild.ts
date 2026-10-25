import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import matter from 'gray-matter';
import Database from 'better-sqlite3';
import { hasSqliteVec } from '../src/lib/server/sqlite-vec-loader';
import { listKnownFiles, deleteFile, upsertFile, markIndexFtsOnly, type FileRow } from './db';
import { chunkMarkdown, normalizeLevel, HARD_MAX_CHARS } from './chunk';
import { parsePrerequisites } from './prerequisites';
import { walkMarkdownFiles as walk } from './walk-md';
import { embedTexts } from '../src/lib/server/embeddings';
import { DOC_PREFIX } from '../src/lib/server/embed-config';
import { getEmbeddingConfig } from '../src/lib/server/providers/config-store';

/**
 * Embedding independence — the walk/hash/chunk/embed/upsert loop
 * that used to live only inside indexer/index-vault.ts's main(), extracted
 * so the app's own in-process reindex (src/lib/server/reindex.ts, the
 * `POST /api/vaults/[id]/reindex` SSE route) can run the EXACT same logic
 * against a database it opened itself (a temp file it will atomically swap
 * into place) instead of shelling out to `npm run index`. The CLI
 * (index-vault.ts) now calls this too, for both its incremental default
 * and `--full` (which just deletes the old db files first, then runs this
 * same loop against a fresh db — the loop itself needs no "am I doing a
 * full rebuild" flag, since an empty `known` map already makes every file
 * look new). CLI console output/behavior is unchanged: index-vault.ts still
 * prints its own summary lines from the returned RebuildStats.
 *
 * Kept in indexer/, not src/lib/server/, for the same reason db.ts is: it
 * must stay importable from the standalone CLI process with no SvelteKit
 * runtime. It does reach into src/lib/server/embeddings.ts (and
 * transitively config-store.ts/secrets.ts/provider-consent.ts/env.ts) —
 * all of those were already established earlier to have zero `$env`
 * dependency for exactly this reason (see embeddings.ts's own doc comment).
 */

async function embedDocuments(texts: string[]): Promise<number[][]> {
	return embedTexts(
		texts.map((t) => `${DOC_PREFIX}${t}`),
		{ purpose: 'document' }
	);
}

function sha256(content: string): string {
	return crypto.createHash('sha256').update(content).digest('hex');
}

/** Ported verbatim from index-vault.ts's own hasOversizedChunk — see its
 * original doc comment for why an unchanged hash alone isn't enough
 * to skip a file. */
function hasOversizedChunk(db: Database.Database, relPath: string): boolean {
	const row = db
		.prepare('SELECT 1 FROM chunks WHERE path = ? AND length(display_text) > ? LIMIT 1')
		.get(relPath, HARD_MAX_CHARS);
	return row !== undefined;
}

export interface RebuildStats {
	indexed: number;
	skipped: number;
	resplit: number;
	deleted: number;
	warnings: number;
	/** Total chunks actually written this run (0 on a dry run) — new, for the app's reindex 'done' SSE event; the CLI's own text
	 * summary doesn't print it (unchanged output), but nothing stops it from
	 * using it later. */
	chunks: number;
	ms: number;
}

export interface RebuildProgress {
	/** Files walked so far, INCLUDING the one at `path` (0-based while it's
	 * being processed, so the very last progress call before `path: ''` has
	 * `done === total`). */
	done: number;
	total: number;
	/** '' only on the final call, once every file has been processed —
	 * signals "still finishing up" (the delete-orphans pass) distinctly from
	 * "about to process this file". */
	path: string;
}

export interface RebuildOptions {
	/** Mirrors index-vault.ts's `--dry-run`: walks and reports, writes nothing
	 * (not even to a non-null `db` — the caller is trusted to have opened one
	 * read-only, or passed null, exactly as index-vault.ts already did). */
	dryRun?: boolean;
	onProgress?: (p: RebuildProgress) => void;
	/** Checked before processing each file AND right before the (slow) embed
	 * call for a file that needs one — an abort mid-embed still finishes that
	 * one HTTP call (nothing here can cancel an in-flight fetch), but never
	 * starts another. Throws a DOMException('AbortError'), the same shape
	 * every other cancellable flow in this app already throws/catches (see
	 * api/chat/+server.ts's flight abort handling). */
	signal?: AbortSignal;
	/** Routine progress lines (e.g. "yeniden bölünüyor") — index-vault.ts
	 * passes console.log; the app's reindex passes nothing (its SSE contract
	 * is start/progress/done/error, not a log tail). */
	onInfo?: (line: string) => void;
	/** Warnings (missing frontmatter, empty content, non-string level) —
	 * index-vault.ts passes console.warn. */
	onWarn?: (line: string) => void;
}

function checkAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new DOMException('Reindex aborted', 'AbortError');
}

/**
 * Runs one full walk of `libraryRoot` against `db` (or, for a dry run,
 * reads its state without writing). `db` may be null exactly when
 * index-vault.ts's own dry-run branch already allowed it: the DB file never
 * existed before this run, so there is nothing to read `known` from either.
 */
export async function rebuildIndex(db: Database.Database | null, libraryRoot: string, opts: RebuildOptions = {}): Promise<RebuildStats> {
	const { dryRun = false, onProgress, signal, onInfo = () => {}, onWarn = () => {} } = opts;
	const startedAt = Date.now();

	// No embedding configured (FTS-only mode) — chunks and keyword data are still written, the
	// embed call and vec_chunks are skipped. An existing vectored index written to this way stops being
	// recorded as vectored (markIndexFtsOnly), so choosing a provider later triggers the mismatch/reindex flow.
	// Also FTS-only when sqlite-vec could not load on this connection (no vec_chunks to write to).
	const ftsOnly = getEmbeddingConfig() === null || (db !== null && !hasSqliteVec(db));
	if (ftsOnly && db && !dryRun) markIndexFtsOnly(db);

	const known = db ? listKnownFiles(db) : new Map<string, FileRow>();
	const seen = new Set<string>();
	const files = walk(libraryRoot);
	const total = files.length;

	let indexed = 0;
	let skipped = 0;
	let warnings = 0;
	let resplit = 0;
	let chunksWritten = 0;

	for (let i = 0; i < files.length; i++) {
		checkAborted(signal);
		const absPath = files[i];
		const relPath = path.relative(libraryRoot, absPath).split(path.sep).join('/');
		onProgress?.({ done: i, total, path: relPath });

		const raw = fs.readFileSync(absPath, 'utf-8');
		const hash = sha256(raw);
		seen.add(relPath);

		const existing = known.get(relPath);
		if (existing && existing.sha256 === hash) {
			// db is guaranteed non-null here: `existing` can only be set from
			// `known`, and `known` is only ever populated when `db` was.
			if (!db || !hasOversizedChunk(db, relPath)) {
				skipped++;
				continue;
			}
			resplit++;
			onInfo(`[yeniden bölünüyor] hash aynı, ama eski parça HARD_MAX_CHARS'ı aşıyor: ${relPath}`);
		}

		const { data } = matter(raw);
		if (!data.title && !data.topic) {
			onWarn(`[uyarı] frontmatter'da title/topic yok, atlandı: ${relPath}`);
			warnings++;
			continue;
		}

		const { frontmatter, chunks } = chunkMarkdown(raw);
		if (chunks.length === 0) {
			onWarn(`[uyarı] içerik boş, atlandı: ${relPath}`);
			warnings++;
			continue;
		}

		const rawLevel = frontmatter.level ?? frontmatter.depth;
		if (rawLevel != null && typeof rawLevel !== 'string') {
			onWarn(`[uyarı] level/depth metin değil (${JSON.stringify(rawLevel)}), boş seviyeye düşürüldü: ${relPath}`);
			warnings++;
		}

		if (!dryRun && db) {
			checkAborted(signal);
			const embeddings = ftsOnly ? null : await embedDocuments(chunks.map((c) => c.embedText));
			const fileRow: FileRow = {
				path: relPath,
				sha256: hash,
				mtime: fs.statSync(absPath).mtimeMs,
				topic: frontmatter.title ?? frontmatter.topic ?? '',
				depth: normalizeLevel(frontmatter.level ?? frontmatter.depth ?? ''),
				domains_json: JSON.stringify(frontmatter.domains ?? (frontmatter.domain ? [frontmatter.domain] : [])),
				prerequisites_json: JSON.stringify(parsePrerequisites(frontmatter.prerequisites))
			};
			upsertFile(
				db,
				fileRow,
				chunks.map((c, idx) => ({
					insert: { path: relPath, heading_path: c.headingPath, display_text: c.displayText },
					embedding: embeddings ? embeddings[idx] : null
				}))
			);
			chunksWritten += chunks.length;
		}
		indexed++;
	}

	let deletedCount = 0;
	for (const knownPath of known.keys()) {
		if (!seen.has(knownPath)) {
			if (!dryRun && db) deleteFile(db, knownPath);
			deletedCount++;
		}
	}

	onProgress?.({ done: total, total, path: '' });

	return { indexed, skipped, resplit, deleted: deletedCount, warnings, chunks: chunksWritten, ms: Date.now() - startedAt };
}
