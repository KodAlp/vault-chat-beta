/**
 * Reciprocal Rank Fusion for combining several ranked retrieval lists (e.g.
 * vector search + keyword search) into one ranking, without needing the
 * lists' scores to be on comparable scales — RRF only looks at rank.
 *
 * Lives in src/lib/server so the app and the MCP server can use it; the benchmark harness re-exports it.
 */

export interface RRFOptions {
	/** Rank-dampening constant; higher k flattens the influence of rank differences. */
	k?: number;
	/** Per-list weight, same length as `lists`. Defaults to 1 for every list. */
	weights?: number[];
}

export interface RRFResult {
	id: string;
	score: number;
}

/**
 * score(id) = sum over lists containing id of weight_l * 1 / (k + rank),
 * rank being the item's 1-indexed position in that list. An id missing from
 * a list contributes 0 for that list, so appearing near the top of several
 * lists beats appearing at the very top of just one.
 *
 * Sorted by score descending; ties are broken deterministically by the
 * item's best (smallest) rank across all lists, then by id, so the fused
 * ranking is reproducible regardless of Map/object iteration order.
 */
export function reciprocalRankFusion(lists: string[][], options: RRFOptions = {}): RRFResult[] {
	const { k = 60, weights } = options;
	if (weights && weights.length !== lists.length) {
		throw new Error(`reciprocalRankFusion: weights length (${weights.length}) must match lists length (${lists.length})`);
	}
	const scores = new Map<string, number>();
	const bestRank = new Map<string, number>();
	lists.forEach((list, listIndex) => {
		const weight = weights ? weights[listIndex] : 1;
		list.forEach((id, i) => {
			const rank = i + 1;
			scores.set(id, (scores.get(id) ?? 0) + (weight * 1) / (k + rank));
			const prevBest = bestRank.get(id);
			if (prevBest === undefined || rank < prevBest) bestRank.set(id, rank);
		});
	});
	return [...scores.entries()]
		.map(([id, score]) => ({ id, score }))
		.sort((a, b) => {
			if (b.score !== a.score) return b.score - a.score;
			const rankDiff = bestRank.get(a.id)! - bestRank.get(b.id)!;
			if (rankDiff !== 0) return rankDiff;
			return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
		});
}
