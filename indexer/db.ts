import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import path from 'node:path';
import fs from 'node:fs';
import { EMBED_DIMS, EMBED_MODEL } from '../src/lib/server/embed-config';
import { ensureColumns } from '../src/lib/server/sqlite-schema';

export interface FileRow {
	path: string;
	sha256: string;
	mtime: number;
	topic: string;
	depth: string;
	domains_json: string;
	/** JSON array of the link target NAMES from the note's `prerequisites` frontmatter
	 * ("np-completeness", not a path) — resolved to files when the graph is read, see
	 * indexer/prerequisites.ts. */
	prerequisites_json: string;
}

export interface ChunkInsert {
	path: string;
	heading_path: string;
	display_text: string;
}

/**
 * Aşama 3a (embedding-bagimsizligi) — which provider/model/dims this
 * particular index's vectors were built with, recorded in `index_meta` so a
 * later config change (providers/config-store.ts's embedding block) can be
 * detected instead of silently comparing incompatible vectors. `provider` is
 * a provider id from providers.json (e.g. 'ollama'), not a display label.
 */
export interface IndexEmbeddingMeta {
	provider: string;
	model: string;
	dims: number;
}

/** What every index built before this feature existed is assumed to be —
 * the exact ollama/bge-m3/1024 triple embed-config.ts hardcoded, since that
 * is genuinely what wrote every such index's vectors. readIndexEmbedding()
 * below is the only place this is used as a fallback; the raw reader
 * (readIndexEmbeddingMeta) returns null instead, so a caller that needs to
 * tell "recorded" from "assumed" apart still can. */
export const LEGACY_INDEX_EMBEDDING: IndexEmbeddingMeta = { provider: 'ollama', model: EMBED_MODEL, dims: EMBED_DIMS };

/**
 * Aşama 4a — what index_meta records for an FTS-only index (no embedding
 * provider was configured when it was written): provider 'none', model 'none',
 * dims 0, and no vec_chunks table. An explicit sentinel rather than "no meta":
 * a missing meta means "built before index_meta existed" (= LEGACY_INDEX_EMBEDDING),
 * which is a different, vectored state. When the user later picks a real
 * embedding provider the normal mismatch check (index 'none' != config) fires
 * and the reindex flow rebuilds with vectors.
 */
export const NO_EMBEDDING_PROVIDER = 'none';
export const FTS_ONLY_INDEX_EMBEDDING: IndexEmbeddingMeta = { provider: NO_EMBEDDING_PROVIDER, model: 'none', dims: 0 };

/** True when the index has no vectors (FTS-only), see FTS_ONLY_INDEX_EMBEDDING. */
export function isFtsOnlyIndex(meta: IndexEmbeddingMeta): boolean {
	return meta.provider === NO_EMBEDDING_PROVIDER;
}

/** The one definition of "the index was built under a different embedding than the config":
 * a null config (FTS-only mode) never mismatches — there is no vector search to protect, and an
 * index that still holds old vectors is simply unused until a provider is configured again. */
export function embeddingMismatches(index: IndexEmbeddingMeta, config: { providerId: string; model: string; dims: number } | null): boolean {
	if (config === null) return false;
	return index.provider !== config.providerId || index.model !== config.model || index.dims !== config.dims;
}

/** Opens (or creates) the index DB with WAL on, so the app can read while this
 * writes. `embedding`, when given, is the config this write is happening
 * under (getEmbeddingConfig(), src/lib/server/providers/config-store.ts) —
 * it sizes a FRESHLY created vec_chunks table's dimension and is recorded
 * into index_meta at that same moment. Omitted (every existing caller before
 * this feature, and this file's own tests): a brand-new DB gets
 * LEGACY_INDEX_EMBEDDING, which is also the assumption an ALREADY-existing
 * index (created before index_meta existed) is read back as — see
 * readIndexEmbedding(). An index that already has a vec_chunks table is
 * never resized or re-tagged here regardless of `embedding`: the dimension
 * is baked into that table's DDL and changing it for real requires deleting
 * the DB and rebuilding (`npm run index -- --full`), never a silent rewrite.
 *
 * Aşama 4a: `embedding === null` is FTS-only mode — a fresh DB gets NO
 * vec_chunks table and index_meta records FTS_ONLY_INDEX_EMBEDDING. An
 * existing index already recorded as FTS-only never grows a vec_chunks table
 * on a later open, whatever `embedding` is passed (it stays 'none' until a
 * reindex rebuilds it). */
export function openDb(dbPath: string, embedding?: IndexEmbeddingMeta | null): Database.Database {
	fs.mkdirSync(path.dirname(dbPath), { recursive: true });
	const db = new Database(dbPath);
	db.pragma('journal_mode = WAL');
	sqliteVec.load(db);

	db.exec(`
		CREATE TABLE IF NOT EXISTS files (
			path TEXT PRIMARY KEY,
			sha256 TEXT NOT NULL,
			mtime INTEGER NOT NULL,
			topic TEXT NOT NULL DEFAULT '',
			depth TEXT NOT NULL DEFAULT '',
			domains_json TEXT NOT NULL DEFAULT '[]',
			prerequisites_json TEXT NOT NULL DEFAULT '[]'
		);
		CREATE TABLE IF NOT EXISTS chunks (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			path TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,
			heading_path TEXT NOT NULL,
			display_text TEXT NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_chunks_path ON chunks(path);
	`);
	// An index built before F4 has `files` without this column, and CREATE TABLE IF NOT EXISTS cannot
	// add it (see sqlite-schema.ts). Additive: nothing needs `--full`; `npm run index -- --prereqs`
	// fills it for files that are already indexed. The app opens the index read-only and cannot add it,
	// so readers must cope with it missing (src/lib/server/prerequisites-query.ts does).
	ensureColumns(db, 'files', { prerequisites_json: "TEXT NOT NULL DEFAULT '[]'" });
	// Dimension AND distance metric are baked into the virtual table DDL —
	// changing either requires `npm run index -- --full` so this table gets
	// dropped and rebuilt. distance_metric=cosine is load-bearing: without it
	// sqlite-vec defaults to L2, which on nomic-embed-text's ~768-dim vectors
	// clusters almost everything around distance 0.85-0.97 regardless of actual
	// relevance — silently breaking retrieve.ts's DISTANCE_THRESHOLD (always
	// calibrated for cosine, ~0.55) so retrieval returned empty for nearly
	// every query without ever raising an error.
	//
	// Aşama 3a: the dimension used to always be EMBED_DIMS (the hardcoded
	// bge-m3 constant); it is now the caller's configured `embedding.dims`
	// when given, falling back to EMBED_DIMS for every caller that predates
	// this feature (this file's own tests, and any openDb() call sites not
	// yet passing a config). `vecTableExisted` is checked BEFORE this exec —
	// CREATE ... IF NOT EXISTS is silently a no-op on an already-existing
	// table, dimension mismatch or not, so this is the one chance to know
	// whether the table (and therefore index_meta) is being created fresh.
	const vecTableExisted = hasVecTable(db);
	db.exec(`
		CREATE TABLE IF NOT EXISTS index_meta (
			key TEXT PRIMARY KEY,
			value TEXT NOT NULL
		);
	`);
	const recordedMeta = readIndexEmbeddingMeta(db);
	const recordedFtsOnly = recordedMeta !== null && isFtsOnlyIndex(recordedMeta);
	const wantsVectors = embedding !== null && !recordedFtsOnly;
	if (wantsVectors) {
		const dims = embedding?.dims ?? EMBED_DIMS;
		db.exec(`
			CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(
				chunk_id INTEGER PRIMARY KEY,
				embedding FLOAT[${dims}] distance_metric=cosine
			);
		`);
	}
	// Only ever written at the moment the index is FIRST created (no vec_chunks
	// table AND no recorded meta) — a real mismatch on a table that already
	// existed must be visible to readIndexEmbedding()'s callers
	// (incrementalIndex.ts's refusal, retrieve.ts's fallback), never quietly
	// overwritten to match whatever config happens to be active on this
	// particular open. An FTS-only index has no vec table by design, so the
	// recorded-meta check is what keeps it from being re-tagged as legacy.
	if (!vecTableExisted && recordedMeta === null) {
		writeIndexEmbeddingMeta(db, embedding === null ? FTS_ONLY_INDEX_EMBEDDING : (embedding ?? LEGACY_INDEX_EMBEDDING));
	}
	if (ensureFts(db)) ftsEnabled.add(db);
	return db;
}

function hasVecTable(db: Database.Database): boolean {
	return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'vec_chunks'").get() !== undefined;
}

/** Marks an existing index as FTS-only: called when chunks are about to be written without vectors
 * (null embedding config) into an index that was recorded under a real embedding — from that moment its
 * vec_chunks no longer covers every chunk, so the recorded meta must stop claiming it does. A later
 * config with a real provider then mismatches and goes through the reindex flow. No-op when already FTS-only. */
export function markIndexFtsOnly(db: Database.Database): void {
	if (isFtsOnlyIndex(readIndexEmbedding(db))) return;
	writeIndexEmbeddingMeta(db, FTS_ONLY_INDEX_EMBEDDING);
}

/** Records which provider/model/dims this index's vectors were built with.
 * Only ever called by openDb() at the moment vec_chunks is first created
 * (see its doc comment) — exported separately so a test can also call it
 * directly against a hand-built DB without going through a full openDb(). */
export function writeIndexEmbeddingMeta(db: Database.Database, embedding: IndexEmbeddingMeta): void {
	const upsert = db.prepare(
		'INSERT INTO index_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
	);
	upsert.run('embed_provider', embedding.provider);
	upsert.run('embed_model', embedding.model);
	upsert.run('embed_dims', String(embedding.dims));
}

/** Raw read: null when index_meta doesn't exist at all (a read-only handle
 * on an index built before this feature — that connection can never create
 * the table itself, so this must degrade gracefully, not throw) or is
 * present but incomplete. Most callers want readIndexEmbedding() below
 * instead, which fills in the legacy assumption; this one exists for a
 * caller that needs to tell "genuinely recorded" apart from "assumed". */
export function readIndexEmbeddingMeta(db: Database.Database): IndexEmbeddingMeta | null {
	const hasTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'index_meta'").get() !== undefined;
	if (!hasTable) return null;
	const rows = db.prepare('SELECT key, value FROM index_meta').all() as { key: string; value: string }[];
	const byKey = new Map(rows.map((r) => [r.key, r.value]));
	const provider = byKey.get('embed_provider');
	const model = byKey.get('embed_model');
	const dimsRaw = byKey.get('embed_dims');
	if (!provider || !model || !dimsRaw) return null;
	const dims = Number(dimsRaw);
	return Number.isFinite(dims) ? { provider, model, dims } : null;
}

/** What every caller outside this file should actually use: the recorded
 * meta, or LEGACY_INDEX_EMBEDDING when there is none — an index with no
 * index_meta table/rows was necessarily built before this feature existed,
 * which means ollama/bge-m3/1024 (see that constant's doc comment), never
 * "unknown". retrieve.ts calls this on its read-only connection; readonly
 * SQLite handles can SELECT from a table that already exists but can never
 * CREATE one, which is exactly why this never tries to. */
export function readIndexEmbedding(db: Database.Database): IndexEmbeddingMeta {
	return readIndexEmbeddingMeta(db) ?? LEGACY_INDEX_EMBEDDING;
}

/** Handles for which the keyword index exists and must be kept in step with
 * `chunks`. A WeakSet, not a field on the handle, so a build of SQLite without
 * FTS5 simply leaves it out and every write below skips the FTS work. */
const ftsEnabled = new WeakSet<Database.Database>();

/**
 * Keyword index for retrieve.ts's fallback (F5). A standalone FTS5 table, NOT
 * an external-content one: with `content='chunks'` every delete must replay the
 * exact original row through a special command or the index silently corrupts,
 * and it costs only a few MB to keep its own copy. `rowid` is `chunks.id`.
 *
 * `porter` stems English ("indexing" ~ "index"); `remove_diacritics 2` folds
 * Turkish letters the same way for both the text and the query.
 *
 * Additive: nothing here needs `--full`. An index built before this existed
 * gets the table filled from `chunks` the first time it is opened for writing
 * (openDb) — no re-embedding. The app itself opens the index read-only and
 * cannot create it, hence `npm run index -- --fts` for an existing index.
 *
 * Returns false (and warns) if this SQLite has no FTS5, so a missing feature
 * can never take indexing down with it.
 */
function ensureFts(db: Database.Database): boolean {
	try {
		db.exec(`
			CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
				heading_path,
				display_text,
				tokenize = 'porter unicode61 remove_diacritics 2'
			);
		`);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.warn(`[fts] FTS5 kullanılamıyor, anahtar kelime yedeği kapalı: ${message}`);
		return false;
	}
	syncFts(db);
	return true;
}

/**
 * Makes `chunks_fts` match `chunks` exactly: adds rows for chunks that have none
 * (an index that predates the table, or was written by an older build during an
 * upgrade) and drops rows whose chunk is gone. Idempotent, and a no-op — two
 * counts — when the tables already agree, which is the normal case.
 */
export function syncFts(db: Database.Database): { added: number; removed: number } {
	const chunks = (db.prepare('SELECT count(*) AS c FROM chunks').get() as { c: number }).c;
	const fts = (db.prepare('SELECT count(*) AS c FROM chunks_fts').get() as { c: number }).c;
	if (chunks === fts) return { added: 0, removed: 0 };
	const run = db.transaction(() => {
		const removed = db.prepare('DELETE FROM chunks_fts WHERE rowid NOT IN (SELECT id FROM chunks)').run().changes;
		const added = db
			.prepare(
				`INSERT INTO chunks_fts (rowid, heading_path, display_text)
				 SELECT id, heading_path, display_text FROM chunks
				 WHERE id NOT IN (SELECT rowid FROM chunks_fts)`
			)
			.run().changes;
		return { added, removed };
	});
	return run();
}

/** Sets one already-indexed file's prerequisite names without touching its chunks or embeddings
 * (`npm run index -- --prereqs`). False when no such file is indexed. */
export function setPrerequisites(db: Database.Database, filePath: string, prerequisitesJson: string): boolean {
	return db.prepare('UPDATE files SET prerequisites_json = ? WHERE path = ?').run(prerequisitesJson, filePath).changes > 0;
}

export function listKnownFiles(db: Database.Database): Map<string, FileRow> {
	const rows = db.prepare('SELECT * FROM files').all() as FileRow[];
	return new Map(rows.map((r) => [r.path, r]));
}

/** Pure metadata rename — chunks/embeddings are unchanged, so this needs no
 * re-chunk/re-embed. Used by the library tree's rename/move action. */
export function renameFileInIndex(db: Database.Database, oldPath: string, newPath: string): void {
	const tx = db.transaction(() => {
		// chunks.path references files.path (no ON UPDATE CASCADE) and better-sqlite3
		// enforces foreign keys by default, so updating files first failed with
		// SQLITE_CONSTRAINT_FOREIGNKEY for every file that had chunks — after
		// library.ts had already renamed the file on disk. Deferring the check to
		// COMMIT lets both rows move together; the pragma resets itself at commit.
		db.pragma('defer_foreign_keys = ON');
		db.prepare('UPDATE files SET path = ? WHERE path = ?').run(newPath, oldPath);
		db.prepare('UPDATE chunks SET path = ? WHERE path = ?').run(newPath, oldPath);
	});
	tx();
}

export function deleteFile(db: Database.Database, filePath: string): void {
	const chunkIds = db.prepare('SELECT id FROM chunks WHERE path = ?').all(filePath) as {
		id: number;
	}[];
	// An FTS-only index has no vec_chunks table at all.
	if (hasVecTable(db)) {
		const delVec = db.prepare('DELETE FROM vec_chunks WHERE chunk_id = ?');
		// sqlite-vec's vec0 rowid check rejects a plain JS number bound param here
		// ("Only integers are allows for primary key values") — BigInt satisfies it.
		for (const { id } of chunkIds) delVec.run(BigInt(id));
	}
	if (ftsEnabled.has(db)) {
		const delFts = db.prepare('DELETE FROM chunks_fts WHERE rowid = ?');
		for (const { id } of chunkIds) delFts.run(id);
	}
	db.prepare('DELETE FROM chunks WHERE path = ?').run(filePath);
	db.prepare('DELETE FROM files WHERE path = ?').run(filePath);
}

export function upsertFile(
	db: Database.Database,
	file: FileRow,
	chunks: { insert: ChunkInsert; embedding: number[] | null }[]
): void {
	const tx = db.transaction(() => {
		deleteFile(db, file.path);
		db.prepare(
			`INSERT INTO files (path, sha256, mtime, topic, depth, domains_json, prerequisites_json)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`
		).run(file.path, file.sha256, file.mtime, file.topic, file.depth, file.domains_json, file.prerequisites_json);

		const insertChunk = db.prepare(
			`INSERT INTO chunks (path, heading_path, display_text) VALUES (?, ?, ?)`
		);
		// null embeddings = FTS-only write (Aşama 4a): the vec table may not even exist, so only prepare it when needed.
		const insertVec = chunks.some((c) => c.embedding !== null) ? db.prepare(`INSERT INTO vec_chunks (chunk_id, embedding) VALUES (?, ?)`) : null;
		const insertFts = ftsEnabled.has(db)
			? db.prepare('INSERT INTO chunks_fts (rowid, heading_path, display_text) VALUES (?, ?, ?)')
			: null;
		for (const { insert, embedding } of chunks) {
			const info = insertChunk.run(insert.path, insert.heading_path, insert.display_text);
			// BigInt, not the plain number lastInsertRowid — see note in deleteFile above.
			if (embedding) insertVec?.run(BigInt(info.lastInsertRowid), Buffer.from(new Float32Array(embedding).buffer));
			insertFts?.run(info.lastInsertRowid, insert.heading_path, insert.display_text);
		}
	});
	tx();
}
