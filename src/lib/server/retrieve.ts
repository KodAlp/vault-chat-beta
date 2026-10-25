import { existsSync, statSync } from 'node:fs';
import Database from 'better-sqlite3';
import { tryLoadSqliteVec, hasSqliteVec } from './sqlite-vec-loader';
import { embedTexts } from './embeddings';
import { QUERY_PREFIX } from './embed-config';
import { getEmbeddingConfig } from './providers/config-store';
import { AppError } from './app-error';
import { selectChunks, type CandidateChunk } from './select-chunks';
import { RERANK_CANDIDATES, pickRerankCandidates, rerankPassage, selectReranked } from './rerank-select';
import { rerank } from './reranker';
import { getLibrarySettings } from './library-read';
import type { RetrieveResult } from '#lib/types.js';
import type { VaultContext } from './vaults';
import { logAppEvent } from './app-log';
import { buildCoOccurrenceQuery, buildFallbackQuery, buildFtsQuery, extractTerms } from './keyword-query';
import { reciprocalRankFusion } from './rrf';
import { domainStats, type DomainStats } from './domain-stats';
import { hasKeywordIndex, keywordSearch, keywordSearchCoOccurring, type KeywordHit } from './keyword-search';
import type { GateDecision } from './smalltalk-gate';
import { normalizeLevel } from '../../../indexer/chunk';
import { walkMarkdownFiles } from '../../../indexer/walk-md';
import { readIndexEmbedding, embeddingMismatches } from '../../../indexer/db';

/** EMBEDDING_* AppError codes embedTexts() throws that retrieve() treats as
 * "vector search is unavailable right now" rather than a hard failure — see
 * RetrieveResult.embeddingIssue's doc comment. Any other AppError (or a
 * non-AppError throw) is a real bug and propagates as before. */
// NOT_FOUND: the configured embedding provider id no longer exists in providers.json (deleted/renamed) —
// embeddings.ts's resolveProviderEntry throws it; for retrieval that is just another "no vectors this turn".
const EMBEDDING_ISSUE_CODES = new Set(['EMBEDDING_UNAVAILABLE', 'EMBEDDING_CONSENT_REQUIRED', 'EMBEDDING_DIMS_MISMATCH', 'NOT_FOUND']);

/**
 * Rate-limits the 'embedding_issue' app-log line. Before this, a
 * persisting mismatch/outage wrote one line per chat turn for as long as it
 * lasted — every one identical, burying the one useful signal ("this
 * started"/"this changed") in noise well before app-log.jsonl's own
 * size-based rotation ever kicked in.
 *
 * Keyed by vault id -> the last signature logged for it (a plain string
 * identifying the (index meta, config) pair for a mismatch, or the error
 * code for an 'unavailable'). A genuinely different situation for that
 * vault — a different mismatch pair, or the reason flipping between
 * mismatch/unavailable — logs immediately, since the signature changes. The
 * SAME exact situation logs once per process: if it recovers and then
 * recurs identically later in the same process's lifetime, that is treated
 * as "still the same known problem", not a new one worth a fresh line — a
 * process restart (which clears this Map) is itself a natural point to log
 * once more if the problem is still there.
 */
const lastLoggedEmbeddingIssue = new Map<string, string>();

function logEmbeddingIssueOnce(vaultId: string, signature: string, message: string, reason: 'mismatch' | 'unavailable'): void {
	if (lastLoggedEmbeddingIssue.get(vaultId) === signature) return;
	lastLoggedEmbeddingIssue.set(vaultId, signature);
	logAppEvent({ kind: 'embedding_issue', message, reason });
}

/** True once `npm run index` has been run for this vault at least once —
 * a direct existsSync check, not list_vaults's `total > 0 ||
 * listDomains().length > 0` heuristic (which cannot tell "never indexed"
 * from "indexed, but genuinely empty"). Lets an MCP tool return a distinct
 * NOT_INDEXED error instead of a silent empty result that reads exactly
 * like "no matches" (mcp/errors.ts already defined the code; nothing
 * produced it). */
export function vaultIsIndexed(v: VaultContext): boolean {
	return existsSync(v.indexDbPath);
}

/**
 * Files on disk that `npm run index` would walk, minus files actually in
 * the index — not against listSources()'s hiddenFolders-filtered total, but
 * the raw `files` table count, so a cards/frontier note that IS indexed
 * (just hidden from list_sources' output) is never miscounted as unindexed.
 *
 * A curation pass (e.g. a knowledge-editor workflow) often only *proposes*
 * `npm run index`, and a proposal that never gets run looks, from both the
 * app and Claude's side, exactly like a vault with no new content at all.
 * Measured on a real vault before this signal existed: 2 curated notes
 * sat unindexed with nothing surfacing it anywhere.
 */
export function countUnindexedFiles(v: VaultContext): number {
	if (!existsSync(v.libraryRoot)) return 0;
	const onDisk = walkMarkdownFiles(v.libraryRoot).length;
	const database = getDb(v);
	if (!database) return onDisk; // never indexed at all: everything is "unindexed"
	const indexed = (database.prepare('SELECT count(*) AS n FROM files').get() as { n: number }).n;
	return Math.max(onDisk - indexed, 0);
}

const DEFAULT_K = 8;
const OVERFETCH_FACTOR = 3;
/** includedPaths (and likewise a domains filter) narrows the candidate pool after the KNN search, not
 * before it — a low overfetch factor means every one of the top k*N
 * nearest neighbors could legitimately fall outside the scope and the
 * result silently comes back empty. Raised from 10: with 2155 chunks
 * post-boilerplate-filtering (see indexer/chunk.ts's isNavigationOnly), a
 * single-folder scope at k=12 (chat's own k, see api/chat/+server.ts) only
 * pulled 120 of 2155 candidates before this — comfortably possible to
 * exhaust on a scope narrower than one wiki/<domain> folder. See
 * vault-registry skill. */
const SCOPED_OVERFETCH_FACTOR = 20;

interface CachedDb {
	db: Database.Database;
	/** Identity of the index file this connection was opened on. */
	ino: number;
	dev: number;
	mtimeMs: number;
	size: number;
}

const dbCache = new Map<string, CachedDb>();

/** True when the file at the path is no longer the one the connection was opened on. On POSIX a
 * reindex renames a fresh index.db over the old one (reindex.ts) and a cached connection would keep
 * reading the unlinked inode forever; Windows refuses that swap while open, so there it never
 * triggers. ino is 0 on some Windows filesystems, so mtime/size then stand in for identity. */
function indexFileChanged(p: string, c: CachedDb): boolean {
	let st: ReturnType<typeof statSync>;
	try {
		st = statSync(p);
	} catch {
		return true;
	}
	if (c.ino !== 0 || st.ino !== 0) return st.ino !== c.ino || st.dev !== c.dev;
	return st.mtimeMs !== c.mtimeMs || st.size !== c.size;
}

/**
 * Thin read-only wrapper over the DB that indexer/db.ts owns and writes.
 * WAL mode (set by the indexer) lets this open safely while `npm run index` runs.
 * One connection per vault, cached for the process lifetime — mirrors the
 * old module-level singleton, just keyed by vault id now.
 */
/** Returns null, not a throw, when the vault has never been indexed
 * (`npm run index` not yet run) — a routine state now that multiple vaults let
 * users create a vault and land straight on its empty chat screen. */
function getDb(v: VaultContext): Database.Database | null {
	const cached = dbCache.get(v.id);
	if (cached) {
		if (!indexFileChanged(v.indexDbPath, cached)) return cached.db;
		try {
			cached.db.close();
		} catch {
			// already closed
		}
		dbCache.delete(v.id);
	}
	if (!existsSync(v.indexDbPath)) return null;
	const instance = new Database(v.indexDbPath, { readonly: true, fileMustExist: true });
	// A failed sqlite-vec load is not an error: the connection just has no vector search (hasSqliteVec) and
	// retrieve() takes the keyword path. Anything else throwing must not leave an open handle uncached — same
	// EBUSY-class fix as chats-db.ts/study-db.ts's getDb().
	try {
		tryLoadSqliteVec(instance);
	} catch (err) {
		instance.close();
		const message = err instanceof Error ? err.message : 'Bilinmeyen hata';
		logAppEvent({ kind: 'db_error', message: `index.db init başarısız (${v.id}): ${message}` });
		throw err;
	}
	const st = statSync(v.indexDbPath);
	dbCache.set(v.id, { db: instance, ino: st.ino, dev: st.dev, mtimeMs: st.mtimeMs, size: st.size });
	return instance;
}

/** Must be called before deleting a vault's files — Windows refuses to
 * remove/rename a file with an open handle (EBUSY), and this cache holds
 * one open connection per vault for the process lifetime. See
 * vaults.ts's deleteVault. No-op if this vault was never queried. */
export function closeVaultIndexDb(vaultId: string): void {
	const entry = dbCache.get(vaultId);
	if (!entry) return;
	entry.db.close();
	dbCache.delete(vaultId);
}

export interface EmbeddingMismatchInfo {
	mismatch: boolean;
	/** Absent when the vault has never been indexed at all — there is
	 * nothing recorded to compare the config against yet (unindexedCount is
	 * the signal for that state, not this). */
	index?: { provider: string; model: string; dims: number };
	/** null in FTS-only mode (no embedding configured) — never a mismatch then. */
	config: { provider: string; model: string; dims: number } | null;
}

/**
 * GET /api/vaults' per-vault `embeddingMismatch` field reads
 * this: same comparison retrieve() itself makes (index_meta vs
 * getEmbeddingConfig()) on the same cached read-only connection getDb()
 * already maintains, so checking status for every vault on the vaults page
 * costs no extra file handles or queries beyond what retrieve() would touch
 * anyway on that vault's next chat turn.
 */
export function checkEmbeddingMismatch(v: VaultContext): EmbeddingMismatchInfo {
	const config = getEmbeddingConfig();
	const configInfo = config ? { provider: config.providerId, model: config.model, dims: config.dims } : null;
	const database = getDb(v);
	if (!database) return { mismatch: false, config: configInfo };
	const indexMeta = readIndexEmbedding(database);
	// Without sqlite-vec a reindex cannot help and no vectors are searched, so nothing to warn about.
	const mismatch = hasSqliteVec(database) && embeddingMismatches(indexMeta, config);
	return { mismatch, index: indexMeta, config: configInfo };
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
	opts: {
		domains?: string[];
		levels?: string[];
		includedPaths?: string[];
		k?: number;
		/** When the vector search leaves nothing usable, try a keyword (FTS5) search
		 * before giving up. Off by default and opted into by the chat route only: the
		 * generators cite what retrieval returns, and a keyword hit carries no
		 * distance to vouch for its relevance. */
		keywordFallback?: boolean;
		/** The text the keyword fallback searches, when it should differ from `query`:
		 * the chat passes the newest user message alone, because `query` carries the
		 * last few turns for the vector search and an AND over all of them would demand
		 * every term of every turn in one chunk. Defaults to `query`. */
		keywordQuery?: string;
		/** Chat only: the small-talk gate (smalltalk-gate.ts, wired in smalltalk-runtime.ts). Called
		 * with the query vector and the nearest chunk's distance; a message it flags gets no sources,
		 * because the vector search cannot tell a greeting from a question and would attach
		 * unrelated ones. The generators never pass it: they cite what retrieval returns. */
		smallTalkGate?: (vector: number[], bestDistance: number | undefined) => GateDecision | null;
		/** "Yine de kaynak ara": retrieve even when the gate flags the message (still reported in `gate`). */
		forceSources?: boolean;
		/** MCP search_library's retrieval mode. 'auto' (default, the chat's behaviour): vector, keyword only as
		 * fallback. 'vector': vector only, never the keyword fallback. 'keyword': FTS5 only (OR over the
		 * terms, no embedding call). 'hybrid': vector KNN and FTS5 BM25 fused with reciprocal rank fusion
		 * (rrf.ts); falls back to keyword-only exactly like 'auto' when vectors cannot run. */
		mode?: 'auto' | 'vector' | 'keyword' | 'hybrid';
		/** Chat only, and only when the user turned the reranker on (providers.json `reranker`): score the
		 * vector candidates with the cross-encoder (reranker.ts) instead of cutting by distance. A best
		 * score under RERANK_MIN_SCORE returns reason 'rerank-no-match' with no sources and no keyword
		 * fallback; a reranker that cannot run changes nothing. Applies to mode 'auto' only. */
		rerank?: boolean;
		/** With `rerank`: the Ollama chat model this turn will generate with (normalized name), so the reranker's VRAM
		 * gate can skip a turn it would hurt. Omit for a cloud chat provider. */
		rerankLocalModel?: string;
	} = {}
): Promise<RetrieveResult> {
	const database = getDb(v);
	if (!database) return { chunks: [], narrowScope: false, reason: 'unindexed' };
	const k = opts.k ?? DEFAULT_K;
	// A topic (domains) filter is a post-filter after the KNN search too, so it needs the same wide pool.
	const overfetch = opts.includedPaths?.length || opts.domains?.length ? SCOPED_OVERFETCH_FACTOR : OVERFETCH_FACTOR;
	const rerankWanted = opts.rerank === true && (opts.mode === undefined || opts.mode === 'auto');
	// The cross-encoder wants RERANK_CANDIDATES survivors of the filters, so the pool may not be smaller than that.
	const knnLimit = rerankWanted ? Math.max(k * overfetch, RERANK_CANDIDATES) : k * overfetch;

	const config = getEmbeddingConfig();
	const indexMeta = readIndexEmbedding(database);
	const metaMismatch = embeddingMismatches(indexMeta, config);

	// A config/index mismatch or a failed embed call means vector
	// search cannot run at all this turn — `vector` stays null and every block
	// below that needs it (KNN, the small-talk gate) is skipped, falling
	// through to the keyword-only path near the bottom of this function
	// regardless of opts.keywordFallback (see its own comment there).
	let vector: number[] | null = null;
	let embeddingIssue: RetrieveResult['embeddingIssue'];
	if (opts.mode === 'keyword') {
		// Explicit keyword mode: no embedding call at all; same typed state as the configured FTS-only mode.
		embeddingIssue = 'fts-only';
	} else if (config === null || !hasSqliteVec(database)) {
		// FTS-only mode: an expected, configured state (or sqlite-vec cannot load on this platform) — typed, but
		// deliberately NOT logged per query.
		embeddingIssue = 'fts-only';
	} else if (metaMismatch) {
		embeddingIssue = 'mismatch';
		const pairSignature = `mismatch:${indexMeta.provider}/${indexMeta.model}/${indexMeta.dims}=>${config.providerId}/${config.model}/${config.dims}`;
		logEmbeddingIssueOnce(
			v.id,
			pairSignature,
			`dizin ${indexMeta.provider}/${indexMeta.model}/${indexMeta.dims} ile oluşturulmuş, ayar ${config.providerId}/${config.model}/${config.dims}`,
			'mismatch'
		);
	} else {
		try {
			// cpuOnly: see ollama.ts embed() — keeps the embedding model out of
			// VRAM on the Ollama path so it does not evict the chat model.
			[vector] = await embedTexts([`${QUERY_PREFIX}${query}`], { purpose: 'query' });
		} catch (err) {
			if (err instanceof AppError && EMBEDDING_ISSUE_CODES.has(err.code)) {
				embeddingIssue = 'unavailable';
				logEmbeddingIssueOnce(v.id, `unavailable:${err.code}`, err.message, 'unavailable');
			} else {
				throw err;
			}
		}
	}

	const matches =
		vector === null
			? []
			: (database
					.prepare(`SELECT chunk_id, distance FROM vec_chunks WHERE embedding MATCH ? AND k = ? ORDER BY distance`)
					.all(Buffer.from(new Float32Array(vector).buffer), knnLimit) as { chunk_id: number; distance: number }[]);

	const bestDistance = matches[0]?.distance;

	// Small talk gets no sources at all. This runs on the vector computed above, so it costs a few
	// dot products, not another model call. Skipped entirely when there is no vector (embeddingIssue
	// set): the gate cannot judge a message it has no embedding for, and a message that isn't small
	// talk must still be able to reach the keyword fallback below, not silently get zero sources.
	let gateInfo: RetrieveResult['gate'];
	const verdict = vector !== null ? (opts.smallTalkGate?.(vector, bestDistance) ?? null) : null;
	if (verdict?.smallTalk) {
		const info = { via: verdict.via, phraseId: verdict.phraseId, phraseSource: verdict.phraseSource, sim: verdict.sim };
		if (!opts.forceSources) {
			return { chunks: [], narrowScope: false, reason: 'small-talk', smallTalk: true, gate: info, bestDistance };
		}
		gateInfo = { ...info, overridden: true };
	}

	const chunkStmt = database.prepare<[number], ChunkRow>(
		`SELECT c.id, c.heading_path, c.display_text, f.path, f.topic, f.depth, f.domains_json
		 FROM chunks c JOIN files f ON f.path = c.path
		 WHERE c.id = ?`
	);
	const toCandidate = (id: number, distance: number, via?: 'keyword'): CandidateChunk | null => {
		const row = chunkStmt.get(id);
		if (!row) return null;
		return {
			path: row.path,
			heading_path: row.heading_path,
			display_text: row.display_text,
			topic: row.topic,
			depth: row.depth,
			domains: JSON.parse(row.domains_json),
			distance,
			...(via ? { via } : {})
		};
	};

	// Always applied, independent of includedPaths/domains — a vault's
	// bookkeeping folders (LibrarySettings.hiddenFolders, e.g. cards/
	// frontier/) are never real study content, so they're excluded from
	// every retrieval the same way they're excluded from SourceTree.svelte,
	// not just an opt-in narrowing the caller has to remember to ask for.
	const excludedPrefixes = getLibrarySettings(v).hiddenFolders;

	const candidates: CandidateChunk[] = [];
	for (const match of matches) {
		const c = toCandidate(match.chunk_id, match.distance);
		if (c) candidates.push(c);
	}
	// Reranker (chat, opt-in): the filters run first so the cross-encoder's slots go to chunks the chat may
	// use; no distance threshold, the score replaces it. An empty filtered pool keeps the plain path below,
	// which is what reports 'scope' / 'filtered'. A reranker that cannot run (null) also keeps that path.
	if (rerankWanted && vector !== null && candidates.length > 0) {
		const pool = pickRerankCandidates(candidates, {
			domains: opts.domains,
			levels: opts.levels,
			includedPaths: opts.includedPaths,
			excludedPrefixes
		});
		const scores = pool.length > 0 ? await rerank(query, pool.map(rerankPassage), { localModel: opts.rerankLocalModel }) : null;
		if (scores) {
			const picked = selectReranked(pool, scores, { k });
			return {
				chunks: picked.chunks,
				narrowScope: false,
				...(picked.noMatch ? { reason: 'rerank-no-match' as const } : {}),
				rerankBest: picked.best,
				bestDistance,
				...(gateInfo ? { gate: gateInfo } : {}),
				...(embeddingIssue ? { embeddingIssue } : {})
			};
		}
	}

	// Hybrid: fuse the vector ranking with a BM25 (OR) ranking by rank only. Keyword-only hits carry
	// via 'keyword' (distance meaningless, threshold skipped); chunks the vector search also found keep
	// their real distance and the threshold. Needs both a vector and a keyword index, else plain 'auto'.
	let hybridCandidates: CandidateChunk[] | null = null;
	if (opts.mode === 'hybrid' && vector !== null && hasKeywordIndex(database)) {
		const expr = buildFtsQuery(opts.keywordQuery ?? query, 'or');
		const kwHits = expr ? keywordSearch(database, expr, k * overfetch) : [];
		if (kwHits.length > 0) {
			const distById = new Map(matches.map((m) => [m.chunk_id, m.distance]));
			const fused = reciprocalRankFusion([
				matches.map((m) => String(m.chunk_id)),
				kwHits.map((h) => String(h.chunkId))
			]);
			hybridCandidates = [];
			for (const f of fused) {
				const id = Number(f.id);
				const d = distById.get(id);
				const c = toCandidate(id, d ?? 1, d === undefined ? 'keyword' : undefined);
				if (c) hybridCandidates.push(c);
			}
		}
	}
	const vectorResult: RetrieveResult =
		hybridCandidates !== null
			? selectChunks(hybridCandidates, { ...opts, excludedPrefixes, k, distanceThreshold: config?.distanceThreshold })
			: matches.length === 0
			? {
					chunks: [],
					narrowScope: false,
					// vector === null means vector search never ran — say so, rather than the misleading
					// "ran and matched nothing" ('no-embedding-match').
					reason: vector === null ? (embeddingIssue === 'fts-only' ? 'fts-only' : 'embedding-unavailable') : 'no-embedding-match'
				}
			: selectChunks(candidates, { ...opts, excludedPrefixes, k, distanceThreshold: config?.distanceThreshold });
	vectorResult.bestDistance = bestDistance;
	if (gateInfo) vectorResult.gate = gateInfo;
	if (embeddingIssue) vectorResult.embeddingIssue = embeddingIssue;

	// Only "the vector search found nothing usable". 'scope' is deliberately
	// excluded: it means relevant content exists outside the user's chosen scope,
	// which the UI answers with "kapsamı genişlet?" — a keyword hit must not
	// paper over that. `embeddingIssue` forces the fallback regardless of
	// opts.keywordFallback — vector search genuinely could not run
	// this turn, which is not a caller opt-in decision the way "try keyword
	// after an empty vector result" is; every caller (chat AND the five
	// generate-*.ts) gets a chance at keyword results, and generate-*.ts is
	// responsible for checking embeddingIssue itself before trusting them
	// (see RetrieveResult.embeddingIssue's doc comment).
	const wantsFallback =
		opts.mode !== 'vector' &&
		(opts.keywordFallback === true || embeddingIssue !== undefined) &&
		vectorResult.chunks.length === 0 &&
		(vectorResult.reason === 'filtered' ||
			vectorResult.reason === 'no-embedding-match' ||
			vectorResult.reason === 'fts-only' ||
			vectorResult.reason === 'embedding-unavailable');
	if (!wantsFallback || !hasKeywordIndex(database)) return vectorResult;

	// One keyword pass over the current message. Both gates are null for fewer than
	// two content terms — a greeting, slang, a follow-up like "neden?" — since one
	// coincidental word is not evidence (keyword-query.ts has the measurements).
	// FTS-only mode (no embedding provider at all) ORs the terms and keeps chunks
	// holding >= 2 distinct ones ('co2'), because AND matched nothing for natural
	// questions there; every transient-failure fallback (unavailable / mismatch /
	// opts.keywordFallback with a working embedder) keeps the stricter AND.
	// Same filters as the vector path; only the distance threshold is skipped:
	// keyword candidates carry via 'keyword', which selectChunks exempts from it,
	// so the co2 path is not dropped by the threshold any more than AND is.
	const fallbackQuery = opts.keywordQuery ?? query;
	const pool = k * (opts.includedPaths?.length || opts.domains?.length ? SCOPED_OVERFETCH_FACTOR : OVERFETCH_FACTOR);
	const mode: 'and' | 'co2' | 'or' = opts.mode === 'keyword' ? 'or' : embeddingIssue === 'fts-only' ? 'co2' : 'and';
	let hits: KeywordHit[];
	if (mode === 'or') {
		// Explicit keyword mode: recall-oriented OR, a single term is enough (the caller asked for keywords).
		const expr = buildFtsQuery(fallbackQuery, 'or');
		if (!expr) return vectorResult;
		hits = keywordSearch(database, expr, pool);
	} else if (mode === 'co2') {
		const co = buildCoOccurrenceQuery(fallbackQuery);
		if (!co) return vectorResult;
		hits = keywordSearchCoOccurring(database, co.expr, co.terms, pool);
	} else {
		const expr = buildFallbackQuery(fallbackQuery);
		if (!expr) return vectorResult;
		hits = keywordSearch(database, expr, pool);
	}
	const keywordCandidates: CandidateChunk[] = [];
	for (const hit of hits) {
		// 1, not a real distance — see RetrievedChunk.distance.
		const c = toCandidate(hit.chunkId, 1, 'keyword');
		if (c) keywordCandidates.push(c);
	}
	const found = selectChunks(keywordCandidates, { ...opts, excludedPrefixes, k, distanceThreshold: config?.distanceThreshold });
	logAppEvent({
		kind: 'retrieval_fallback',
		message: `anahtar kelime yedeği (${mode}): ${hits.length} isabet, ${found.chunks.length} kullanılabilir`,
		mode,
		terms: extractTerms(fallbackQuery).length,
		hits: hits.length,
		chunks: found.chunks.length
	});
	if (found.chunks.length > 0) {
		return {
			...found,
			keyword: true,
			bestDistance,
			...(gateInfo ? { gate: gateInfo } : {}),
			...(embeddingIssue ? { embeddingIssue } : {})
		};
	}
	return vectorResult;
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

/** Per-domain note counts and newest mtime (MCP list_domains); reads the index, hidden folders excluded. */
export function listDomainStats(v: VaultContext): DomainStats {
	const database = getDb(v);
	if (!database) return { domains: [], noDomain: 0, totalNotes: 0 };
	return domainStats(database, getLibrarySettings(v).hiddenFolders);
}

/** Levels actually present in the index — same reasoning as listDomains():
 * mirrors reality instead of a hardcoded undergrad/grad/phd list, which
 * would silently misrepresent a vault using different terminology. Used
 * by the list_vaults MCP tool. */
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

/** The list_sources MCP tool — deliberately reads the index DB, not
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
		// normalizeLevel, not just lower() — a caller can reasonably type
		// "undergraduate" and expect it to match the canonical "undergrad"
		// depth values normalizeLevel folds every write to.
		conditions.push(`(${opts.levels.map(() => 'lower(f.depth) = lower(?)').join(' OR ')})`);
		params.push(...opts.levels.map((l) => normalizeLevel(l)));
	}

	// A vault's bookkeeping folders (raw/cards/frontier/...) are never real
	// study content — list_sources used to list them anyway (330 files for
	// the real default vault: 304 wiki + 26 raw/cards/frontier/_meta), while
	// search_library already excluded them via retrieve()'s excludedPrefixes.
	// A path is excluded if it equals a prefix or starts with `${prefix}/`;
	// substr-equality, not LIKE, because a prefix like "wiki/_index" contains
	// `_`, a LIKE single-char wildcard that would need its own escaping.
	const excludedPrefixes = getLibrarySettings(v).hiddenFolders;
	if (excludedPrefixes.length) {
		conditions.push(excludedPrefixes.map(() => `NOT (f.path = ? OR substr(f.path, 1, ?) = ?)`).join(' AND '));
		for (const p of excludedPrefixes) params.push(p, p.length + 1, `${p}/`);
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
