import type Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

/**
 * Loads the sqlite-vec extension into one connection, or reports that it cannot be. sqlite-vec
 * ships per-platform binaries (none for windows-arm64 as of 0.1.9), and a missing or blocked binary
 * must not make the whole vault unopenable: FTS5 keyword search needs none of it. Callers treat
 * `false` as "FTS-only for this connection" — no vec_chunks reads/writes, no embedding calls.
 */
let loader: (db: Database.Database) => void = (db) => sqliteVec.load(db);
let warned = false;
const available = new WeakSet<Database.Database>();

export function tryLoadSqliteVec(db: Database.Database): boolean {
	try {
		loader(db);
		available.add(db);
		return true;
	} catch (err) {
		if (!warned) {
			warned = true;
			const message = err instanceof Error ? err.message : String(err);
			console.warn(`[sqlite-vec] yüklenemedi, vektör araması kapalı (yalnız anahtar kelime): ${message}`);
		}
		return false;
	}
}

/** True when tryLoadSqliteVec() succeeded on this very connection. */
export function hasSqliteVec(db: Database.Database): boolean {
	return available.has(db);
}

/** Test seam: replaces the loader (null restores the real one) and re-arms the once-per-process warning. */
export function setSqliteVecLoaderForTest(fn: ((db: Database.Database) => void) | null): void {
	loader = fn ?? ((db) => sqliteVec.load(db));
	warned = false;
}
