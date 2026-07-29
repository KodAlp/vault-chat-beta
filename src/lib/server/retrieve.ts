import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import path from 'node:path';
import { env } from '$env/dynamic/private';
import { embed } from './ollama';
import { EMBED_MODEL, QUERY_PREFIX } from './embed-config';
import type { RetrievedChunk } from '$lib/types';

const DEFAULT_K = 8;
const DISTANCE_THRESHOLD = 0.55;
const MAX_CHUNKS_PER_FILE = 3;
const OVERFETCH_FACTOR = 3;

let db: Database.Database | undefined;

/**
 * Thin read-only wrapper over the DB that indexer/db.ts owns and writes.
 * WAL mode (set by the indexer) lets this open safely while `npm run index` runs.
 */
function getDb(): Database.Database {
	if (!db) {
		const dbPath = env.INDEX_DB_PATH ?? path.join('data', 'vault-index.db');
		db = new Database(dbPath, { readonly: true, fileMustExist: true });
		sqliteVec.load(db);
	}
	return db;
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
	query: string,
	opts: { domains?: string[]; k?: number } = {}
): Promise<RetrievedChunk[]> {
	const database = getDb();
	const k = opts.k ?? DEFAULT_K;

	const [vector] = await embed([`${QUERY_PREFIX}${query}`], EMBED_MODEL);
	const queryBlob = Buffer.from(new Float32Array(vector).buffer);

	const matches = database
		.prepare(
			`SELECT chunk_id, distance FROM vec_chunks WHERE embedding MATCH ? AND k = ? ORDER BY distance`
		)
		.all(queryBlob, k * OVERFETCH_FACTOR) as { chunk_id: number; distance: number }[];

	if (matches.length === 0) return [];

	const chunkStmt = database.prepare<[number], ChunkRow>(
		`SELECT c.id, c.heading_path, c.display_text, f.path, f.topic, f.depth, f.domains_json
		 FROM chunks c JOIN files f ON f.path = c.path
		 WHERE c.id = ?`
	);

	const perFileCount = new Map<string, number>();
	const results: RetrievedChunk[] = [];
	for (const match of matches) {
		if (match.distance > DISTANCE_THRESHOLD) continue;
		const row = chunkStmt.get(match.chunk_id);
		if (!row) continue;

		const domains: string[] = JSON.parse(row.domains_json);
		if (opts.domains?.length && !opts.domains.some((d) => domains.includes(d))) continue;

		const count = perFileCount.get(row.path) ?? 0;
		if (count >= MAX_CHUNKS_PER_FILE) continue;
		perFileCount.set(row.path, count + 1);

		results.push({
			path: row.path,
			heading_path: row.heading_path,
			display_text: row.display_text,
			topic: row.topic,
			depth: row.depth,
			domains,
			distance: match.distance
		});
		if (results.length >= k) break;
	}
	return results;
}

/** Domains actually present in the index, not a hardcoded list — stays
 * accurate as the vault grows without needing to be kept in sync by hand. */
export function listDomains(): string[] {
	const rows = getDb()
		.prepare(`SELECT DISTINCT d.value AS domain FROM files, json_each(files.domains_json) AS d ORDER BY d.value`)
		.all() as { domain: string }[];
	return rows.map((r) => r.domain);
}
