import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import path from 'node:path';
import fs from 'node:fs';
import { EMBED_DIMS } from '../src/lib/server/embed-config';
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

/** Opens (or creates) the index DB with WAL on, so the app can read while this writes. */
export function openDb(dbPath: string): Database.Database {
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
	db.exec(`
		CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(
			chunk_id INTEGER PRIMARY KEY,
			embedding FLOAT[${EMBED_DIMS}] distance_metric=cosine
		);
	`);
	if (ensureFts(db)) ftsEnabled.add(db);
	return db;
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
	const delVec = db.prepare('DELETE FROM vec_chunks WHERE chunk_id = ?');
	// sqlite-vec's vec0 rowid check rejects a plain JS number bound param here
	// ("Only integers are allows for primary key values") — BigInt satisfies it.
	for (const { id } of chunkIds) delVec.run(BigInt(id));
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
	chunks: { insert: ChunkInsert; embedding: number[] }[]
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
		const insertVec = db.prepare(`INSERT INTO vec_chunks (chunk_id, embedding) VALUES (?, ?)`);
		const insertFts = ftsEnabled.has(db)
			? db.prepare('INSERT INTO chunks_fts (rowid, heading_path, display_text) VALUES (?, ?, ?)')
			: null;
		for (const { insert, embedding } of chunks) {
			const info = insertChunk.run(insert.path, insert.heading_path, insert.display_text);
			// BigInt, not the plain number lastInsertRowid — see note in deleteFile above.
			insertVec.run(BigInt(info.lastInsertRowid), Buffer.from(new Float32Array(embedding).buffer));
			insertFts?.run(info.lastInsertRowid, insert.heading_path, insert.display_text);
		}
	});
	tx();
}
