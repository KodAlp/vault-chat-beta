import type Database from 'better-sqlite3';

/**
 * Query side of the keyword index (indexer/db.ts owns and writes `chunks_fts`).
 * Takes a connection instead of opening one so it works with retrieve.ts's
 * read-only handle and with a temp DB in tests, and imports nothing from
 * SvelteKit so `tsx --test` can run it.
 */

export interface KeywordHit {
	chunkId: number;
	/** FTS5's bm25(): LOWER is better (it returns negative numbers), so callers
	 * sort ascending. Unlike a vector distance it says nothing about relevance in
	 * absolute terms, only how the hits rank against each other. */
	score: number;
}

/** Whether the keyword index exists on this connection. False for an index that
 * was built before the keyword fallback existed and has not been refreshed with
 * `npm run index -- --fts`, and for a SQLite build without FTS5. */
export function hasKeywordIndex(db: Database.Database): boolean {
	return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'chunks_fts'").get() !== undefined;
}

/**
 * Best keyword matches for an FTS5 MATCH expression built by
 * keyword-query.ts's buildFtsQuery(), best first. Never throws: any SQLite error
 * (a malformed expression, a corrupt index) is "no keyword hits", because this
 * only ever runs as a fallback and must not turn a missing-context answer into
 * an error.
 */
export function keywordSearch(db: Database.Database, matchExpr: string, limit: number): KeywordHit[] {
	if (!Number.isInteger(limit) || limit < 1) return [];
	try {
		const rows = db
			.prepare('SELECT rowid AS id, bm25(chunks_fts) AS score FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY score LIMIT ?')
			.all(matchExpr, limit) as { id: number; score: number }[];
		return rows.map((r) => ({ chunkId: r.id, score: r.score }));
	} catch {
		return [];
	}
}

/** How many OR hits are pulled before the co-occurrence filter, so that filtering
 * does not starve the result when the best BM25 hits only contain one term. */
const CO_OCCURRENCE_POOL = 50;

/**
 * FTS-only mode's search: BM25 over an OR expression (keyword-query.ts's
 * buildCoOccurrenceQuery), keeping only chunks in which at least `minTerms`
 * DISTINCT terms occur, still in BM25 order. "Does term t occur in chunk c" is
 * asked of FTS5 itself, one quoted term at a time restricted to the candidate
 * rowids: the index tokenizer (porter, unicode61, remove_diacritics) is the only
 * thing that can answer it the way MATCH did, so no substring or token matching
 * is redone in JS. Never throws, like keywordSearch().
 */
export function keywordSearchCoOccurring(
	db: Database.Database,
	matchExpr: string,
	terms: string[],
	limit: number,
	minTerms = 2
): KeywordHit[] {
	if (!Number.isInteger(limit) || limit < 1) return [];
	const hits = keywordSearch(db, matchExpr, Math.max(limit, CO_OCCURRENCE_POOL));
	if (hits.length === 0) return [];
	try {
		const ids = hits.map((h) => h.chunkId);
		const stmt = db.prepare(
			`SELECT rowid AS id FROM chunks_fts WHERE chunks_fts MATCH ? AND rowid IN (${ids.map(() => '?').join(',')})`
		);
		const matched = new Map<number, number>();
		for (const t of new Set(terms)) {
			for (const r of stmt.all(`"${t.replace(/"/g, '""')}"`, ...ids) as { id: number }[]) {
				matched.set(r.id, (matched.get(r.id) ?? 0) + 1);
			}
		}
		return hits.filter((h) => (matched.get(h.chunkId) ?? 0) >= minTerms).slice(0, limit);
	} catch {
		return [];
	}
}
