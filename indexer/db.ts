import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import path from 'node:path';
import fs from 'node:fs';
import { EMBED_DIMS } from '../src/lib/server/embed-config';

export interface FileRow {
	path: string;
	sha256: string;
	mtime: number;
	topic: string;
	depth: string;
	domains_json: string;
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
			domains_json TEXT NOT NULL DEFAULT '[]'
		);
		CREATE TABLE IF NOT EXISTS chunks (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			path TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,
			heading_path TEXT NOT NULL,
			display_text TEXT NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_chunks_path ON chunks(path);
	`);
	// Dimension is baked into the virtual table DDL — changing EMBED_DIMS requires
	// `npm run index -- --full` so this table gets dropped and rebuilt at the new size.
	db.exec(`
		CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(
			chunk_id INTEGER PRIMARY KEY,
			embedding FLOAT[${EMBED_DIMS}]
		);
	`);
	return db;
}

export function listKnownFiles(db: Database.Database): Map<string, FileRow> {
	const rows = db.prepare('SELECT * FROM files').all() as FileRow[];
	return new Map(rows.map((r) => [r.path, r]));
}

export function deleteFile(db: Database.Database, filePath: string): void {
	const chunkIds = db.prepare('SELECT id FROM chunks WHERE path = ?').all(filePath) as {
		id: number;
	}[];
	const delVec = db.prepare('DELETE FROM vec_chunks WHERE chunk_id = ?');
	// sqlite-vec's vec0 rowid check rejects a plain JS number bound param here
	// ("Only integers are allows for primary key values") — BigInt satisfies it.
	for (const { id } of chunkIds) delVec.run(BigInt(id));
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
			`INSERT INTO files (path, sha256, mtime, topic, depth, domains_json)
			 VALUES (?, ?, ?, ?, ?, ?)`
		).run(file.path, file.sha256, file.mtime, file.topic, file.depth, file.domains_json);

		const insertChunk = db.prepare(
			`INSERT INTO chunks (path, heading_path, display_text) VALUES (?, ?, ?)`
		);
		const insertVec = db.prepare(`INSERT INTO vec_chunks (chunk_id, embedding) VALUES (?, ?)`);
		for (const { insert, embedding } of chunks) {
			const info = insertChunk.run(insert.path, insert.heading_path, insert.display_text);
			// BigInt, not the plain number lastInsertRowid — see note in deleteFile above.
			insertVec.run(BigInt(info.lastInsertRowid), Buffer.from(new Float32Array(embedding).buffer));
		}
	});
	tx();
}
