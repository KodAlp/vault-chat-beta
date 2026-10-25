import type { RetrievedChunk } from '$lib/types';
import { candidateVerdict, MAX_CHUNKS_PER_FILE, type CandidateChunk, type CandidateFilters } from './select-chunks';

/**
 * Pure candidate handling around the cross-encoder (reranker.ts), kept free of
 * DB and process dependencies so it runs under plain `tsx --test`.
 *
 * Numbers are measured on the 330-question golden set (the benchmark harness, bge-reranker-v2-m3, sigmoid
 * scores): vector top-30 -> rerank -> top 6 lifts Recall@5 0.688 -> 0.740. A best score below
 * 0.02 means the vault has nothing on the question (all 15 unanswerable questions fall under
 * it; 7 of 305 answerable ones do). Applied per chunk as well it raised source precision
 * 0.364 -> 0.43 at recall 0.775 -> 0.75.
 */
export const RERANK_MIN_SCORE = 0.02;
/** How many candidates reach the cross-encoder (30 cost ~0.5-0.8 s on the RTX 4050). */
export const RERANK_CANDIDATES = 30;

/** Text the cross-encoder sees: the same string the indexer embeds, as in the benchmark. */
export function rerankPassage(c: Pick<CandidateChunk, 'topic' | 'heading_path' | 'display_text'>): string {
	return `[${c.topic} | ${c.heading_path}] ${c.display_text}`;
}

/**
 * The first `limit` candidates (nearest first) that survive the hidden-folder, scope, domain and
 * level filters. Filtering BEFORE the cross-encoder keeps its 30 slots for chunks the chat may
 * actually use. No distance threshold: the reranker replaces it.
 */
export function pickRerankCandidates(
	candidates: CandidateChunk[],
	filters: CandidateFilters,
	limit: number = RERANK_CANDIDATES
): CandidateChunk[] {
	const out: CandidateChunk[] = [];
	for (const c of candidates) {
		if (candidateVerdict(c, filters) !== 'pass') continue;
		out.push(c);
		if (out.length >= limit) break;
	}
	return out;
}

export interface RerankSelection {
	/** Highest score over all candidates (0 when there are none). */
	best: number;
	/** True when `best` is under the threshold: the caller reports "no relevant source". */
	noMatch: boolean;
	/** Candidates at or above the threshold, best first, per-file and k limits applied. */
	chunks: RetrievedChunk[];
}

/**
 * Orders candidates by reranker score and cuts them: below `minScore` is dropped, at most
 * MAX_CHUNKS_PER_FILE per file, at most `k` in total. `scores[i]` belongs to `candidates[i]`;
 * a missing score counts as 0. Equal scores keep the vector order (stable sort).
 */
export function selectReranked(
	candidates: CandidateChunk[],
	scores: number[],
	opts: { k: number; minScore?: number }
): RerankSelection {
	const minScore = opts.minScore ?? RERANK_MIN_SCORE;
	const scored = candidates.map((c, i) => ({ c, score: Number.isFinite(scores[i]) ? scores[i] : 0 }));
	const best = scored.reduce((m, s) => Math.max(m, s.score), 0);
	if (scored.length === 0 || best < minScore) return { best, noMatch: true, chunks: [] };

	scored.sort((a, b) => b.score - a.score);
	const perFile = new Map<string, number>();
	const chunks: RetrievedChunk[] = [];
	for (const { c, score } of scored) {
		if (score < minScore) break; // sorted: everything after is lower
		const n = perFile.get(c.path) ?? 0;
		if (n >= MAX_CHUNKS_PER_FILE) continue;
		perFile.set(c.path, n + 1);
		chunks.push({
			path: c.path,
			heading_path: c.heading_path,
			display_text: c.display_text,
			topic: c.topic,
			depth: c.depth,
			domains: c.domains,
			distance: c.distance,
			rerankScore: score
		});
		if (chunks.length >= opts.k) break;
	}
	return { best, noMatch: false, chunks };
}
