import { existsSync } from 'node:fs';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { embed } from './ollama';
import { EMBED_MODEL, QUERY_PREFIX } from './embed-config';
import { selectChunks, type CandidateChunk } from './select-chunks';
import { getLibrarySettings } from './library-read';
import type { RetrieveResult } from '$lib/types';
import type { VaultContext } from './vaults';
import { logAppEvent } from './app-log';

const DEFAULT_K = 8;
const OVERFETCH_FACTOR = 3;
/** includedPaths narrows the candidate pool after the KNN search, not
 * before it — a low overfetch factor means every one of the top k*N
 * nearest neighbors could legitimately fall outside the scope and the
 * result silently comes back empty. Raised from 10: with 2155 chunks
 * post-boilerplate-filtering (see indexer/chunk.ts's isNavigationOnly), a
 * single-folder scope at k=12 (chat's own k, see api/chat/+server.ts) only
 * pulled 120 of 2155 candidates before this — comfortably possible to
 * exhaust on a scope narrower than one wiki/<domain> folder. See
 * vault-registry skill. */
const SCOPED_OVERFETCH_FACTOR = 20;

const dbCache = new Map<string, Database.Database>();

/**
 * Thin read-only wrapper over the DB that indexer/db.ts owns and writes.
 * WAL mode (set by the indexer) lets this open safely while `npm run index` runs.
 * One connection per vault, cached for the process lifetime — mirrors the
 * old module-level singleton, just keyed by vault id now.
 */
/** Returns null, not a throw, when the vault has never been indexed
 * (`npm run index` not yet run) — a routine state now that Faz 9 lets
 * users create a vault and land straight on its empty chat screen. */
function getDb(v: VaultContext): Database.Database | null {
	let db = dbCache.get(v.id);
	if (db) return db;
	if (!existsSync(v.indexDbPath)) return null;
	const instance = new Database(v.indexDbPath, { readonly: true, fileMustExist: true });
	// sqliteVec.load() failing must not leave an open handle uncached — same
	// EBUSY-class fix as chats-db.ts/study-db.ts's getDb().
	try {
		sqliteVec.load(instance);
	} catch (err) {
		instance.close();
		const message = err instanceof Error ? err.message : 'Bilinmeyen hata';
		logAppEvent({ kind: 'db_error', message: `index.db init başarısız (${v.id}): ${message}` });
		throw err;
	}
	dbCache.set(v.id, instance);
	return instance;
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
	opts: { domains?: string[]; levels?: string[]; includedPaths?: string[]; k?: number } = {}
): Promise<RetrieveResult> {
	const database = getDb(v);
	if (!database) return { chunks: [], narrowScope: false, reason: 'unindexed' };
	const k = opts.k ?? DEFAULT_K;
	const overfetch = opts.includedPaths?.length ? SCOPED_OVERFETCH_FACTOR : OVERFETCH_FACTOR;

	// cpuOnly: see ollama.ts embed() — keeps bge-m3 out of VRAM so it does not
	// evict the chat model on every turn.
	const [vector] = await embed([`${QUERY_PREFIX}${query}`], EMBED_MODEL, { cpuOnly: true });
	const queryBlob = Buffer.from(new Float32Array(vector).buffer);

	const matches = database
		.prepare(
			`SELECT chunk_id, distance FROM vec_chunks WHERE embedding MATCH ? AND k = ? ORDER BY distance`
		)
		.all(queryBlob, k * overfetch) as { chunk_id: number; distance: number }[];

	if (matches.length === 0) return { chunks: [], narrowScope: false, reason: 'no-embedding-match' };

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

	// Always applied, independent of includedPaths/domains — a vault's
	// bookkeeping folders (LibrarySettings.hiddenFolders, e.g. cards/
	// frontier/) are never real study content, so they're excluded from
	// every retrieval the same way they're excluded from SourceTree.svelte,
	// not just an opt-in narrowing the caller has to remember to ask for.
	const excludedPrefixes = getLibrarySettings(v).hiddenFolders;

	return selectChunks(candidates, { ...opts, excludedPrefixes, k });
}

/** Domains actually present in the index, not a hardcoded list — stays
 * accurate as the vault grows without needing to be kept in sync by hand. */
export function listDomains(v: VaultContext): string[] {
	const database = getDb(v);
	if (!database) return [];
	const rows = database
		.prepare(`SELECT DISTINCT d.value AS domain FROM files, json_each(files.domains_json) AS d ORDER BY d.value`)
		.all() as { domain: string }[];
	return rows.map((r) => r.domain);
}

/** Levels actually present in the index — same reasoning as listDomains():
 * mirrors reality instead of a hardcoded undergrad/grad/phd list, which
 * would silently misrepresent a vault using different terminology. Used
 * by Faz 10's list_vaults MCP tool. */
export function listLevels(v: VaultContext): string[] {
	const database = getDb(v);
	if (!database) return [];
	const rows = database.prepare(`SELECT DISTINCT depth FROM files ORDER BY depth`).all() as {
		depth: string;
	}[];
	return rows.map((r) => r.depth);
}

export interface SourceSummary {
	path: string;
	title: string;
	level: string;
	domains: string[];
	chunks: number;
}

/** Faz 10's list_sources MCP tool — deliberately reads the index DB, not
 * getLibraryTree()'s fs walk: one query gives title/level/domains/chunk
 * count for every file with zero per-file readFileSync+gray-matter, and
 * the semantics are honest about what an agent can actually retrieve
 * (an unindexed or frontmatter-less file simply won't appear). Lives here,
 * not in a separate module, so getDb/closeVaultIndexDb stay the single
 * owner of index.db connections — see the mcp-server skill. */
export function listSources(
	v: VaultContext,
	opts: { domains?: string[]; levels?: string[]; limit?: number; offset?: number } = {}
): { total: number; sources: SourceSummary[] } {
	const database = getDb(v);
	if (!database) return { total: 0, sources: [] };

	const limit = opts.limit ?? 200;
	const offset = opts.offset ?? 0;
	const conditions: string[] = [];
	const params: unknown[] = [];

	if (opts.domains?.length) {
		conditions.push(
			`EXISTS (SELECT 1 FROM json_each(f.domains_json) d WHERE ${opts.domains
				.map(() => 'lower(d.value) = lower(?)')
				.join(' OR ')})`
		);
		params.push(...opts.domains);
	}
	if (opts.levels?.length) {
		conditions.push(`(${opts.levels.map(() => 'lower(f.depth) = lower(?)').join(' OR ')})`);
		params.push(...opts.levels);
	}
	const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

	const total = (
		database.prepare(`SELECT count(*) AS n FROM files f ${where}`).get(...params) as { n: number }
	).n;

	const rows = database
		.prepare(
			`SELECT f.path, f.topic, f.depth, f.domains_json,
			        (SELECT count(*) FROM chunks c WHERE c.path = f.path) AS chunks
			 FROM files f
			 ${where}
			 ORDER BY f.path
			 LIMIT ? OFFSET ?`
		)
		.all(...params, limit, offset) as {
		path: string;
		topic: string;
		depth: string;
		domains_json: string;
		chunks: number;
	}[];

	return {
		total,
		sources: rows.map((r) => ({
			path: r.path,
			title: r.topic,
			level: r.depth,
			domains: JSON.parse(r.domains_json) as string[],
			chunks: r.chunks
		}))
	};
}
