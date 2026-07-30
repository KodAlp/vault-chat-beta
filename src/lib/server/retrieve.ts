import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { embed } from './ollama';
import { EMBED_MODEL, QUERY_PREFIX } from './embed-config';
import { selectChunks, type CandidateChunk } from './select-chunks';
import type { RetrieveResult } from '$lib/types';
import type { VaultContext } from './vaults';

const DEFAULT_K = 8;
const OVERFETCH_FACTOR = 3;
/** includedPaths narrows the candidate pool after the KNN search, not
 * before it — a low overfetch factor means every one of the top k*3
 * nearest neighbors could legitimately fall outside the scope and the
 * result silently comes back empty. See vault-registry skill. */
const SCOPED_OVERFETCH_FACTOR = 10;

const dbCache = new Map<string, Database.Database>();

/**
 * Thin read-only wrapper over the DB that indexer/db.ts owns and writes.
 * WAL mode (set by the indexer) lets this open safely while `npm run index` runs.
 * One connection per vault, cached for the process lifetime — mirrors the
 * old module-level singleton, just keyed by vault id now.
 */
function getDb(v: VaultContext): Database.Database {
	let db = dbCache.get(v.id);
	if (!db) {
		db = new Database(v.indexDbPath, { readonly: true, fileMustExist: true });
		sqliteVec.load(db);
		dbCache.set(v.id, db);
	}
	return db;
}

/** Must be called before deleting a vault's files — Windows refuses to
 * remove/rename a file with an open handle (EBUSY), and this cache holds
 * one open connection per vault for the process lifetime. See
 * vaults.ts's deleteVault. No-op if this vault was never queried. */
export function closeVaultIndexDb(vaultId: string): void {
	const db = dbCache.get(vaultId);
	if (!db) return;
	db.close();
	dbCache.delete(vaultId);
}

interface ChunkRow {
	id: number;
	heading_path: string;
	display_text: string;
	path: string;
	topic: string;
	depth: string;
	domains_json: string;
}

/**
 * Semantics owned by the vault-rag-index skill: KNN over vec_chunks (default k=8),
 * post-filter by domains, dedupe to max 3 chunks per source file, and drop the
 * whole result set to empty if nothing clears the distance threshold — that is
 * what stops the model from citing sources it never actually saw.
 */
export async function retrieve(
	v: VaultContext,
	query: string,
	opts: { domains?: string[]; includedPaths?: string[]; k?: number } = {}
): Promise<RetrieveResult> {
	const database = getDb(v);
	const k = opts.k ?? DEFAULT_K;
	const overfetch = opts.includedPaths?.length ? SCOPED_OVERFETCH_FACTOR : OVERFETCH_FACTOR;

	const [vector] = await embed([`${QUERY_PREFIX}${query}`], EMBED_MODEL);
	const queryBlob = Buffer.from(new Float32Array(vector).buffer);

	const matches = database
		.prepare(
			`SELECT chunk_id, distance FROM vec_chunks WHERE embedding MATCH ? AND k = ? ORDER BY distance`
		)
		.all(queryBlob, k * overfetch) as { chunk_id: number; distance: number }[];

	if (matches.length === 0) return { chunks: [], narrowScope: false };

	const chunkStmt = database.prepare<[number], ChunkRow>(
		`SELECT c.id, c.heading_path, c.display_text, f.path, f.topic, f.depth, f.domains_json
		 FROM chunks c JOIN files f ON f.path = c.path
		 WHERE c.id = ?`
	);

	const candidates: CandidateChunk[] = [];
	for (const match of matches) {
		const row = chunkStmt.get(match.chunk_id);
		if (!row) continue;
		candidates.push({
			path: row.path,
			heading_path: row.heading_path,
			display_text: row.display_text,
			topic: row.topic,
			depth: row.depth,
			domains: JSON.parse(row.domains_json),
			distance: match.distance
		});
	}

	return selectChunks(candidates, { ...opts, k });
}

/** Domains actually present in the index, not a hardcoded list — stays
 * accurate as the vault grows without needing to be kept in sync by hand. */
export function listDomains(v: VaultContext): string[] {
	const rows = getDb(v)
		.prepare(`SELECT DISTINCT d.value AS domain FROM files, json_each(files.domains_json) AS d ORDER BY d.value`)
		.all() as { domain: string }[];
	return rows.map((r) => r.domain);
}
