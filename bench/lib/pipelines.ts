import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { retrieve } from '../../src/lib/server/retrieve';
import { buildRetrievalQuery } from '../../src/lib/server/retrieval-query';
import { buildFtsQuery, extractTerms, type FtsMode } from '../../src/lib/server/keyword-query';
import { keywordSearch } from '../../src/lib/server/keyword-search';
import { getLibrarySettings } from '../../src/lib/server/library-read';
// Dev-tooling default only — the app itself reads the Ollama provider's baseUrl from providers.json.
const prodOllamaUrl = (): string => process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434';
import { QUERY_PREFIX } from '../../src/lib/server/embed-config';
import { embeddingKey } from '../../src/lib/server/embeddings';
import { getEmbeddingConfig } from '../../src/lib/server/providers/config-store';
import { readIndexEmbedding, embeddingMismatches, isFtsOnlyIndex } from '../../indexer/db';
import type { VaultContext } from '../../src/lib/server/vaults';
import type { ChatMessage } from '../../src/lib/types';
import { chunkAnchor, type ChunkLike } from './anchor';
import { reciprocalRankFusion } from './fusion';
import { EmbedCache } from './embed-cache';
import { RerankerClient } from './reranker';

/**
 * Retrieval pipeline variants for the RAG benchmark. Every variant is a pure
 * async function `(ctx, item) -> PipelineOutput` so run-retrieval.ts can loop
 * over items x variants uniformly. `prod`/`prod+kw` call the REAL
 * src/lib/server/retrieve.ts so its threshold/dedupe/hidden-folder logic is
 * measured as-is; every other variant reimplements just enough of that logic
 * (hidden-folder filtering, the same query text, the same candidate pool
 * size) to be a fair, comparable baseline — see each function's own comment
 * for exactly what it does and does not share with prod.
 *
 * Free of `$env`/`$lib` *runtime* behavior — the few src/lib/server imports
 * used here (retrieve.ts, retrieval-query.ts, keyword-query.ts,
 * keyword-search.ts, library-read.ts, env.ts, embed-config.ts, embeddings.ts,
 * providers/config-store.ts) are the same
 * ones the vault-rag-index/mcp-server skills already established work fine
 * under plain `tsx` (no Vite, no $env/dynamic/private) — see retrieve.ts's
 * own doc comments.
 */

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested in pipelines.test.ts — no DB, no network)
// ---------------------------------------------------------------------------

/** Same exact-or-subpath rule as select-chunks.ts's isExcluded (not exported
 * there) — a vault's bookkeeping folders (LibrarySettings.hiddenFolders) must
 * disappear from every pipeline's candidate pool the same way they disappear
 * from prod's, or a non-prod variant would look better or worse than prod
 * purely because it can see notes prod administratively hides. */
export function isHiddenPath(filePath: string, excludedPrefixes: string[]): boolean {
	return excludedPrefixes.some((p) => filePath === p || filePath.startsWith(`${p}/`));
}

export interface QueryTurn {
	role: 'user' | 'assistant';
	content: string;
}

export interface QueryItem {
	question: string;
	turns?: QueryTurn[];
}

/** `[...turns, {role:'user', content: question}]` as a ChatMessage[] —
 * buildRetrievalQuery only reads `.role`/`.content`, so the synthetic `id`s
 * here are never observed. */
export function buildQueryMessages(item: QueryItem): ChatMessage[] {
	const turns = item.turns ?? [];
	const messages: ChatMessage[] = turns.map((t, i) => ({ id: `turn-${i}`, role: t.role, content: t.content }));
	messages.push({ id: 'question', role: 'user', content: item.question });
	return messages;
}

/** The query text every variant embeds/searches with — chat's own multi-turn
 * assembly (retrieval-query.ts), so a follow-up item behaves like a real chat
 * turn instead of a bare question. */
export function queryForItem(item: QueryItem): string {
	return buildRetrievalQuery(buildQueryMessages(item));
}

/** P/N-th percentile of `values` (0-100, linear interpolation between the two
 * nearest ranks). Returns NaN for an empty input rather than throwing — a
 * latency slice can legitimately be empty (e.g. no cold-start samples for a
 * variant that was never run). Does not mutate `values`. */
export function percentile(values: number[], p: number): number {
	if (values.length === 0) return NaN;
	const sorted = [...values].sort((a, b) => a - b);
	if (sorted.length === 1) return sorted[0];
	const rank = (p / 100) * (sorted.length - 1);
	const lo = Math.floor(rank);
	const hi = Math.ceil(rank);
	if (lo === hi) return sorted[lo];
	return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
}

// ---------------------------------------------------------------------------
// Candidate chunks: DB-backed, but the merge/anchor logic below is pure
// ---------------------------------------------------------------------------

export interface CandidateChunk extends ChunkLike {
	topic: string;
	depth: string;
	domains: string[];
}

/** Merges several candidate lists into one anchor -> chunk map, first
 * occurrence wins (all lists describe the same index snapshot, so a shared
 * anchor always means identical content). Pure — no DB, used by fuseCandidates
 * and directly testable with hand-built CandidateChunk fixtures. */
export function mergeCandidateMap(lists: CandidateChunk[][]): Map<string, CandidateChunk> {
	const map = new Map<string, CandidateChunk>();
	for (const list of lists) {
		for (const c of list) {
			const a = chunkAnchor(c);
			if (!map.has(a)) map.set(a, c);
		}
	}
	return map;
}

export function anchorIds(candidates: CandidateChunk[]): string[] {
	return candidates.map((c) => chunkAnchor(c));
}

export interface ScoredCandidate {
	candidate: CandidateChunk;
	score: number;
}

/** RRF over 2+ ranked candidate lists (bench/lib/fusion.ts), resolved back to
 * full CandidateChunk objects and truncated to `topN`. Pure given the
 * candidate lists — no DB, no network. k=60 matches the build brief. */
export function fuseCandidates(lists: CandidateChunk[][], topN: number): ScoredCandidate[] {
	const anchorMap = mergeCandidateMap(lists);
	const idLists = lists.map(anchorIds);
	const fused = reciprocalRankFusion(idLists, { k: 60 });
	const out: ScoredCandidate[] = [];
	for (const f of fused) {
		const c = anchorMap.get(f.id);
		if (!c) continue;
		out.push({ candidate: c, score: f.score });
		if (out.length >= topN) break;
	}
	return out;
}

// ---------------------------------------------------------------------------
// Pipeline context: the one DB connection + caches shared across an item x
// variant loop (run-retrieval.ts owns its lifetime)
// ---------------------------------------------------------------------------

export interface PipelineContext {
	v: VaultContext;
	db: InstanceType<typeof Database>;
	excludedPrefixes: string[];
	embedCache: EmbedCache;
	/** embeddingKey() of the configured embedding, checked against the index's
	 * index_meta at open time — the cache key for every query vector. */
	embedKey: string;
	qxCache: QxCache;
	reranker?: RerankerClient;
	ollamaUrl: string;
	/** Candidate pool size for every non-prod variant's own KNN/BM25 fetch. */
	poolSize: number;
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

function makeChunkLookup(db: InstanceType<typeof Database>): (id: number) => CandidateChunk | null {
	const stmt = db.prepare<[number], ChunkRow>(
		`SELECT c.id, c.heading_path, c.display_text, f.path, f.topic, f.depth, f.domains_json
		 FROM chunks c JOIN files f ON f.path = c.path
		 WHERE c.id = ?`
	);
	return (id: number) => {
		const row = stmt.get(id);
		if (!row) return null;
		return {
			path: row.path,
			heading_path: row.heading_path,
			display_text: row.display_text,
			topic: row.topic,
			depth: row.depth,
			domains: JSON.parse(row.domains_json)
		};
	};
}

export function openPipelineContext(
	v: VaultContext,
	opts: {
		embedCache: EmbedCache;
		qxCache?: QxCache;
		reranker?: RerankerClient;
		ollamaUrl?: string;
		poolSize?: number;
	}
): PipelineContext {
	const db = new Database(v.indexDbPath, { readonly: true, fileMustExist: true });
	sqliteVec.load(db);
	// Same refusal retrieve() makes on a mismatch, but loud: a benchmark that
	// silently compared vectors from two different models would measure nothing.
	const config = getEmbeddingConfig();
	const indexMeta = readIndexEmbedding(db);
	if (!config || isFtsOnlyIndex(indexMeta) || embeddingMismatches(indexMeta, config)) {
		db.close();
		const cfg = config ? `${config.providerId}/${config.model}/${config.dims}` : 'yok (yalnız FTS)';
		throw new Error(
			`Gömme yapılandırması (${cfg}) indeksle (${indexMeta.provider}/${indexMeta.model}/${indexMeta.dims}) uyuşmuyor; ` +
				"vektör karşılaştırması anlamsız olur. Kasayı yapılandırılmış modelle yeniden indeksleyin ya da providers.json'u indeksin modeline döndürün."
		);
	}
	return {
		v,
		db,
		excludedPrefixes: getLibrarySettings(v).hiddenFolders,
		embedCache: opts.embedCache,
		embedKey: embeddingKey(config),
		qxCache: opts.qxCache ?? new QxCache(),
		reranker: opts.reranker,
		ollamaUrl: opts.ollamaUrl ?? prodOllamaUrl(),
		poolSize: opts.poolSize ?? 50
	};
}

export function closePipelineContext(ctx: PipelineContext): void {
	ctx.db.close();
}

// ---------------------------------------------------------------------------
// DB-backed candidate fetch (vector / bm25), hidden-folder filtered exactly
// like prod's excludedPrefixes
// ---------------------------------------------------------------------------

interface VectorSearchResult {
	candidates: (CandidateChunk & { distance: number })[];
	ms: number;
}

function vectorSearch(ctx: PipelineContext, vector: number[], poolSize: number): VectorSearchResult {
	const lookup = makeChunkLookup(ctx.db);
	const blob = Buffer.from(new Float32Array(vector).buffer);
	const t0 = Date.now();
	const matches = ctx.db
		.prepare(`SELECT chunk_id, distance FROM vec_chunks WHERE embedding MATCH ? AND k = ? ORDER BY distance`)
		.all(blob, poolSize) as { chunk_id: number; distance: number }[];
	const ms = Date.now() - t0;
	const candidates: (CandidateChunk & { distance: number })[] = [];
	for (const m of matches) {
		const c = lookup(m.chunk_id);
		if (!c) continue;
		if (isHiddenPath(c.path, ctx.excludedPrefixes)) continue;
		candidates.push({ ...c, distance: m.distance });
	}
	return { candidates, ms };
}

interface Bm25SearchResult {
	candidates: (CandidateChunk & { score: number })[];
	ms: number;
}

function bm25Search(ctx: PipelineContext, text: string, mode: FtsMode, poolSize: number): Bm25SearchResult {
	const expr = buildFtsQuery(text, mode);
	if (!expr) return { candidates: [], ms: 0 };
	const lookup = makeChunkLookup(ctx.db);
	const t0 = Date.now();
	const hits = keywordSearch(ctx.db, expr, poolSize);
	const ms = Date.now() - t0;
	const candidates: (CandidateChunk & { score: number })[] = [];
	for (const h of hits) {
		const c = lookup(h.chunkId);
		if (!c) continue;
		if (isHiddenPath(c.path, ctx.excludedPrefixes)) continue;
		candidates.push({ ...c, score: h.score });
	}
	return { candidates, ms };
}

// ---------------------------------------------------------------------------
// Reranking
// ---------------------------------------------------------------------------

/** Same passage string the indexer embeds (indexer/chunk.ts's `embedText`),
 * so the cross-encoder sees exactly the text bge-m3 saw at index time,
 * truncated by the Python side's tokenizer max-length. */
function passageText(c: CandidateChunk): string {
	return `[${c.topic} | ${c.heading_path}] ${c.display_text}`;
}

async function rerankToTop10(
	ctx: PipelineContext,
	queryText: string,
	candidates: CandidateChunk[],
	via: string
): Promise<{ ranked: RankedItem[]; rerankMs: number }> {
	if (!ctx.reranker) throw new Error('bu varyant reranker gerektiriyor ama PipelineContext.reranker tanımlı değil');
	if (candidates.length === 0) return { ranked: [], rerankMs: 0 };
	const passages = candidates.map(passageText);
	const { scores, ms } = await ctx.reranker.rerank(queryText, passages);
	const scored = candidates.map((c, i) => ({ candidate: c, score: scores[i] ?? 0 }));
	scored.sort((a, b) => b.score - a.score);
	const ranked: RankedItem[] = scored.slice(0, 10).map((s) => ({
		anchor: chunkAnchor(s.candidate),
		path: s.candidate.path,
		heading_path: s.candidate.heading_path,
		score: s.score,
		via
	}));
	return { ranked, rerankMs: ms };
}

// ---------------------------------------------------------------------------
// Query expansion (hybrid+rerank+qx), disk-cached
// ---------------------------------------------------------------------------

export interface QxResult {
	en_query: string;
	keywords: string[];
}

const DEFAULT_QX_CACHE_PATH = path.join('data', 'vaults', 'default', 'bench', 'cache', 'qx.json');
const QX_MODEL = 'qwen3:8b';

export class QxCache {
	private cache: Record<string, QxResult> = {};
	private readonly cachePath: string;

	constructor(cachePath: string = DEFAULT_QX_CACHE_PATH) {
		this.cachePath = cachePath;
		this.load();
	}

	private load(): void {
		try {
			this.cache = JSON.parse(fs.readFileSync(this.cachePath, 'utf-8')) as Record<string, QxResult>;
		} catch {
			this.cache = {};
		}
	}

	private persist(): void {
		fs.mkdirSync(path.dirname(this.cachePath), { recursive: true });
		fs.writeFileSync(this.cachePath, JSON.stringify(this.cache), 'utf-8');
	}

	get(key: string): QxResult | undefined {
		return this.cache[key];
	}

	set(key: string, value: QxResult): void {
		this.cache[key] = value;
		this.persist();
	}
}

function qxKey(model: string, text: string): string {
	return createHash('sha1').update(model + '\u0000' + text).digest('hex');
}

/**
 * English rewrite + keywords of `text` via qwen3:8b (Ollama /api/chat, JSON
 * mode, temperature 0, thinking off) — the corpus is mostly English notes
 * while questions are often Turkish (see embed-config.ts's doc comment on
 * why bge-m3 was chosen over nomic for exactly this gap). Falls back to
 * `{en_query: text, keywords: []}` on any network/parse failure — a benchmark
 * run must never crash because Ollama hiccuped on one query expansion call.
 */
export async function expandQuery(ctx: PipelineContext, text: string): Promise<{ result: QxResult; ms: number }> {
	const key = qxKey(QX_MODEL, text);
	const hit = ctx.qxCache.get(key);
	if (hit) return { result: hit, ms: 0 };

	const t0 = Date.now();
	const result: QxResult = { en_query: text, keywords: [] };
	try {
		const res = await fetch(`${ctx.ollamaUrl}/api/chat`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				model: QX_MODEL,
				messages: [
					{
						role: 'system',
						content:
							'You rewrite search questions. Respond with strict JSON only, no prose, no markdown: {"en_query": string, "keywords": string[]}. en_query is an English rewrite of the question suitable for searching an English-language technical knowledge base. keywords is 3 to 6 English keywords capturing the question\'s key terms.'
					},
					{ role: 'user', content: text }
				],
				stream: false,
				think: false,
				format: 'json',
				options: { temperature: 0 }
			})
		});
		if (res.ok) {
			const data = (await res.json()) as { message?: { content?: string } };
			const content = data.message?.content ?? '';
			const parsed = JSON.parse(content) as Partial<QxResult>;
			if (typeof parsed.en_query === 'string' && parsed.en_query.trim()) result.en_query = parsed.en_query;
			if (Array.isArray(parsed.keywords)) {
				result.keywords = parsed.keywords.filter((k): k is string => typeof k === 'string');
			}
		}
	} catch {
		// network/parse failure — keep the identity fallback set above.
	}
	const ms = Date.now() - t0;
	ctx.qxCache.set(key, result);
	return { result, ms };
}

// ---------------------------------------------------------------------------
// Pipeline output shape
// ---------------------------------------------------------------------------

export interface RankedItem {
	anchor: string;
	path: string;
	heading_path: string;
	/** Higher is better across every variant (1-distance for vector-based
	 * scores, -bm25 for keyword scores, the RRF score, or the reranker's
	 * sigmoid score), so run-retrieval.ts never needs to know which variant
	 * produced a given ranking to sort or display it. */
	score: number;
	via?: string;
}

export interface PipelineTimings {
	embedMs?: number;
	knnMs?: number;
	ftsMs?: number;
	rerankMs?: number;
	qxMs?: number;
	totalMs: number;
}

export interface PipelineOutput {
	ranked: RankedItem[];
	timings: PipelineTimings;
	meta?: Record<string, unknown>;
}

export type PipelineFn = (ctx: PipelineContext, item: QueryItem) => Promise<PipelineOutput>;

// ---------------------------------------------------------------------------
// Variants
// ---------------------------------------------------------------------------

/** The real chat-facing retrieve() at chat's own k (see the build brief —
 * CHAT_RETRIEVAL_K default 6), no keyword fallback. Its threshold, per-file
 * cap and hidden-folder exclusion all run exactly as they do in production. */
async function prodPipeline(ctx: PipelineContext, item: QueryItem): Promise<PipelineOutput> {
	const t0 = Date.now();
	const query = queryForItem(item);
	const result = await retrieve(ctx.v, query, { k: 6 });
	const totalMs = Date.now() - t0;
	const ranked: RankedItem[] = result.chunks.slice(0, 10).map((c) => ({
		anchor: chunkAnchor(c),
		path: c.path,
		heading_path: c.heading_path,
		score: 1 - c.distance,
		via: c.via ?? 'prod'
	}));
	return {
		ranked,
		timings: { totalMs },
		meta: { reason: result.reason, bestDistance: result.bestDistance, keyword: result.keyword ?? false }
	};
}

/** The exact call chat/+server.ts makes: keywordFallback on, keywordQuery is
 * the bare question (not the multi-turn query) — see retrieve.ts's doc
 * comment on why the fallback uses the newest message alone. */
async function prodKwPipeline(ctx: PipelineContext, item: QueryItem): Promise<PipelineOutput> {
	const t0 = Date.now();
	const query = queryForItem(item);
	const result = await retrieve(ctx.v, query, { k: 6, keywordFallback: true, keywordQuery: item.question });
	const totalMs = Date.now() - t0;
	const ranked: RankedItem[] = result.chunks.slice(0, 10).map((c) => ({
		anchor: chunkAnchor(c),
		path: c.path,
		heading_path: c.heading_path,
		score: 1 - c.distance,
		via: c.via ?? 'prod'
	}));
	return {
		ranked,
		timings: { totalMs },
		meta: { reason: result.reason, bestDistance: result.bestDistance, keyword: result.keyword ?? false }
	};
}

/** Raw KNN top-50 (hidden folders excluded), no distance threshold, no
 * per-file cap — the baseline the 0.60 threshold and per-file dedupe are
 * measured against (run-retrieval.ts's threshold sweep reads `meta.candidates`). */
async function vectorRawPipeline(ctx: PipelineContext, item: QueryItem): Promise<PipelineOutput> {
	const t0 = Date.now();
	const query = queryForItem(item);
	const { vector, ms: embedMs } = await ctx.embedCache.embedCached(`${QUERY_PREFIX}${query}`, ctx.embedKey);
	const { candidates, ms: knnMs } = vectorSearch(ctx, vector, ctx.poolSize);
	const ranked: RankedItem[] = candidates.slice(0, 10).map((c) => ({
		anchor: chunkAnchor(c),
		path: c.path,
		heading_path: c.heading_path,
		score: 1 - c.distance,
		via: 'vector'
	}));
	const totalMs = Date.now() - t0;
	return {
		ranked,
		timings: { embedMs, knnMs, totalMs },
		meta: {
			candidates: candidates.map((c) => ({
				anchor: chunkAnchor(c),
				path: c.path,
				heading_path: c.heading_path,
				distance: c.distance
			}))
		}
	};
}

/** BM25 alone, top-50 pool -> top-10. The "current message" is the bare
 * question, same as prod+kw's keyword fallback. */
async function bm25Pipeline(ctx: PipelineContext, item: QueryItem): Promise<PipelineOutput> {
	const t0 = Date.now();
	const { candidates, ms: ftsMs } = bm25Search(ctx, item.question, 'or', ctx.poolSize);
	const ranked: RankedItem[] = candidates.slice(0, 10).map((c) => ({
		anchor: chunkAnchor(c),
		path: c.path,
		heading_path: c.heading_path,
		score: -c.score,
		via: 'bm25'
	}));
	const totalMs = Date.now() - t0;
	return { ranked, timings: { ftsMs, totalMs } };
}

/** RRF(vector top-50, bm25 top-50), k=60 -> top-10. */
async function hybridPipeline(ctx: PipelineContext, item: QueryItem): Promise<PipelineOutput> {
	const t0 = Date.now();
	const query = queryForItem(item);
	const { vector, ms: embedMs } = await ctx.embedCache.embedCached(`${QUERY_PREFIX}${query}`, ctx.embedKey);
	const { candidates: vecCands, ms: knnMs } = vectorSearch(ctx, vector, ctx.poolSize);
	const { candidates: bmCands, ms: ftsMs } = bm25Search(ctx, item.question, 'or', ctx.poolSize);
	const scored = fuseCandidates([vecCands, bmCands], 10);
	const ranked: RankedItem[] = scored.map((s) => ({
		anchor: chunkAnchor(s.candidate),
		path: s.candidate.path,
		heading_path: s.candidate.heading_path,
		score: s.score,
		via: 'hybrid'
	}));
	const totalMs = Date.now() - t0;
	return { ranked, timings: { embedMs, knnMs, ftsMs, totalMs } };
}

/** Vector top-30 -> cross-encoder -> top-10, reranked against the same
 * multi-turn query text used for retrieval. */
async function vectorRerankPipeline(ctx: PipelineContext, item: QueryItem): Promise<PipelineOutput> {
	const t0 = Date.now();
	const query = queryForItem(item);
	const { vector, ms: embedMs } = await ctx.embedCache.embedCached(`${QUERY_PREFIX}${query}`, ctx.embedKey);
	const { candidates, ms: knnMs } = vectorSearch(ctx, vector, ctx.poolSize);
	const top30 = candidates.slice(0, 30);
	const { ranked, rerankMs } = await rerankToTop10(ctx, query, top30, 'rerank');
	const totalMs = Date.now() - t0;
	return { ranked, timings: { embedMs, knnMs, rerankMs, totalMs } };
}

/** RRF top-30 (vector + bm25) -> cross-encoder -> top-10. */
async function hybridRerankPipeline(ctx: PipelineContext, item: QueryItem): Promise<PipelineOutput> {
	const t0 = Date.now();
	const query = queryForItem(item);
	const { vector, ms: embedMs } = await ctx.embedCache.embedCached(`${QUERY_PREFIX}${query}`, ctx.embedKey);
	const { candidates: vecCands, ms: knnMs } = vectorSearch(ctx, vector, ctx.poolSize);
	const { candidates: bmCands, ms: ftsMs } = bm25Search(ctx, item.question, 'or', ctx.poolSize);
	const scored30 = fuseCandidates([vecCands, bmCands], 30);
	const { ranked, rerankMs } = await rerankToTop10(
		ctx,
		query,
		scored30.map((s) => s.candidate),
		'rerank'
	);
	const totalMs = Date.now() - t0;
	return { ranked, timings: { embedMs, knnMs, ftsMs, rerankMs, totalMs } };
}

/**
 * RRF(vector(query), vector(en_query), bm25(question), bm25(en_query+keywords)),
 * k=60 -> top-30 -> cross-encoder reranked against the ORIGINAL question (the
 * cross-encoder is multilingual, so it does not need the English rewrite) ->
 * top-10. "orig" for the vector leg is the same multi-turn `query` every other
 * vector variant uses; "orig" for the bm25 leg is the bare question, matching
 * bm25/prod+kw's own convention.
 */
async function hybridRerankQxPipeline(ctx: PipelineContext, item: QueryItem): Promise<PipelineOutput> {
	const t0 = Date.now();
	const query = queryForItem(item);
	const { result: qx, ms: qxMs } = await expandQuery(ctx, query);

	const embOrig = await ctx.embedCache.embedCached(`${QUERY_PREFIX}${query}`, ctx.embedKey);
	const embEn = await ctx.embedCache.embedCached(`${QUERY_PREFIX}${qx.en_query}`, ctx.embedKey);
	const vecOrig = vectorSearch(ctx, embOrig.vector, ctx.poolSize);
	const vecEn = vectorSearch(ctx, embEn.vector, ctx.poolSize);
	const bmOrig = bm25Search(ctx, item.question, 'or', ctx.poolSize);
	const enKwText = [qx.en_query, ...qx.keywords].join(' ');
	const bmEnKw = bm25Search(ctx, enKwText, 'or', ctx.poolSize);

	const scored30 = fuseCandidates([vecOrig.candidates, vecEn.candidates, bmOrig.candidates, bmEnKw.candidates], 30);
	const { ranked, rerankMs } = await rerankToTop10(
		ctx,
		item.question,
		scored30.map((s) => s.candidate),
		'rerank'
	);
	const totalMs = Date.now() - t0;
	return {
		ranked,
		timings: {
			embedMs: embOrig.ms + embEn.ms,
			knnMs: vecOrig.ms + vecEn.ms,
			ftsMs: bmOrig.ms + bmEnKw.ms,
			rerankMs,
			qxMs,
			totalMs
		},
		meta: { en_query: qx.en_query, keywords: qx.keywords }
	};
}

// ---------------------------------------------------------------------------
// Keyword-only (FTS-only mode) experiments — Aşama 4 açık madde 1
// ---------------------------------------------------------------------------

/** Structural prefix stem: no word list, language-independent. 'fixed' keeps the
 * first n chars, 'ratio' keeps ceil(len*r) chars; never below minLen, short terms untouched. */
function stemTerm(term: string, how: { kind: 'fixed'; n: number } | { kind: 'ratio'; r: number }, minLen = 4): string {
	const keep = how.kind === 'fixed' ? how.n : Math.ceil(term.length * how.r);
	const k = Math.max(minLen, keep);
	return term.length > k ? term.slice(0, k) : term;
}

function keywordOnlyPipeline(opts: { stem?: { kind: 'fixed'; n: number } | { kind: 'ratio'; r: number }; minCoverage?: number; minCoTerms?: number; maxDf?: number }): PipelineFn {
	return async (ctx, item) => {
		const t0 = Date.now();
		let terms = extractTerms(item.question);
		if (opts.maxDf) {
			const n = (ctx.db.prepare('SELECT count(*) AS n FROM chunks_fts').get() as { n: number }).n;
			const dfStmt = ctx.db.prepare('SELECT count(*) AS n FROM chunks_fts WHERE chunks_fts MATCH ?');
			terms = terms.filter((t) => (dfStmt.get(`"${t}"`) as { n: number }).n / n < opts.maxDf!);
			if (opts.minCoTerms && terms.length < opts.minCoTerms) return { ranked: [], timings: { ftsMs: 0, totalMs: Date.now() - t0 } };
		}
		const stems = [...new Set(terms.map((t) => (opts.stem ? stemTerm(t, opts.stem) : t)))];
		if (stems.length === 0) return { ranked: [], timings: { ftsMs: 0, totalMs: Date.now() - t0 } };
		const termExpr = (t: string) => `"${t.replace(/"/g, '""')}"${opts.stem ? '*' : ''}`;
		const expr = stems.map(termExpr).join(' OR ');
		const lookup = makeChunkLookup(ctx.db);
		const tf = Date.now();
		const hits = keywordSearch(ctx.db, expr, ctx.poolSize);
		// Per-term match sets, asked of FTS itself so the check uses the index's own tokenizer
		// (porter + unicode61 remove_diacritics) instead of an approximation of it.
		const matchedTerms = new Map<number, number>();
		if ((opts.minCoverage || opts.minCoTerms) && hits.length > 0) {
			const ids = hits.map((h) => h.chunkId);
			const placeholders = ids.map(() => '?').join(',');
			const stmt = ctx.db.prepare(`SELECT rowid AS id FROM chunks_fts WHERE chunks_fts MATCH ? AND rowid IN (${placeholders})`);
			for (const t of stems) {
				for (const r of stmt.all(termExpr(t), ...ids) as { id: number }[]) matchedTerms.set(r.id, (matchedTerms.get(r.id) ?? 0) + 1);
			}
		}
		const ftsMs = Date.now() - tf;
		const ranked: RankedItem[] = [];
		for (const h of hits) {
			const c = lookup(h.chunkId);
			if (!c || isHiddenPath(c.path, ctx.excludedPrefixes)) continue;
			const m = matchedTerms.get(h.chunkId) ?? 0;
			if (opts.minCoverage && m / stems.length < opts.minCoverage) continue;
			if (opts.minCoTerms && m < opts.minCoTerms) continue;
			ranked.push({ anchor: chunkAnchor(c), path: c.path, heading_path: c.heading_path, score: -h.score, via: 'kw' });
			if (ranked.length === 10) break;
		}
		return { ranked, timings: { ftsMs, totalMs: Date.now() - t0 } };
	};
}

export const VARIANT_NAMES = [
	'prod',
	'prod+kw',
	'vector-raw',
	'bm25',
	'hybrid',
	'vector+rerank',
	'hybrid+rerank',
	'hybrid+rerank+qx',
	'kw-p5',
	'kw-p70',
	'kw-cov30',
	'kw-p5-cov30',
	'kw-p5-cov50',
	'kw-co2',
	'kw-co2-df5',
	'kw-co2-df2'
] as const;

export type VariantName = (typeof VARIANT_NAMES)[number];

export const PIPELINES: Record<VariantName, PipelineFn> = {
	prod: prodPipeline,
	'prod+kw': prodKwPipeline,
	'vector-raw': vectorRawPipeline,
	bm25: bm25Pipeline,
	hybrid: hybridPipeline,
	'vector+rerank': vectorRerankPipeline,
	'hybrid+rerank': hybridRerankPipeline,
	'hybrid+rerank+qx': hybridRerankQxPipeline,
	'kw-p5': keywordOnlyPipeline({ stem: { kind: 'fixed', n: 5 } }),
	'kw-p70': keywordOnlyPipeline({ stem: { kind: 'ratio', r: 0.7 } }),
	'kw-cov30': keywordOnlyPipeline({ minCoverage: 0.3 }),
	'kw-p5-cov30': keywordOnlyPipeline({ stem: { kind: 'fixed', n: 5 }, minCoverage: 0.3 }),
	'kw-p5-cov50': keywordOnlyPipeline({ stem: { kind: 'fixed', n: 5 }, minCoverage: 0.5 }),
	'kw-co2': keywordOnlyPipeline({ minCoTerms: 2 }),
	'kw-co2-df5': keywordOnlyPipeline({ minCoTerms: 2, maxDf: 0.05 }),
	'kw-co2-df2': keywordOnlyPipeline({ minCoTerms: 2, maxDf: 0.02 })
};

/** Which variants call into ctx.reranker — run-retrieval.ts uses this to
 * decide whether it needs to spawn the Python reranker process at all. */
export const RERANK_VARIANTS: readonly VariantName[] = ['vector+rerank', 'hybrid+rerank', 'hybrid+rerank+qx'];
