/**
 * Ranking-quality metrics for the RAG benchmark.
 *
 * Every metric takes `retrieved: string[]` — a ranked list of ids (chunk
 * anchors, or file paths after `dedupeToFiles`), possibly empty — and
 * `relevance: Map<string, number>`, the golden-set grade for each id that is
 * actually relevant (2 = relevant, 1 = partially relevant). An id absent from
 * the map is treated as grade 0. Binary metrics (recall, hit, precision, RR)
 * treat any grade >= 1 as relevant; nDCG uses the graded value directly.
 *
 * Free of `$lib` / `$env` imports so `bench/` runs under plain `tsx`.
 */

export type Relevance = Map<string, number>;

function relevantCount(relevance: Relevance): number {
	let n = 0;
	for (const g of relevance.values()) if (g >= 1) n++;
	return n;
}

function gradeOf(id: string, relevance: Relevance): number {
	return relevance.get(id) ?? 0;
}

/**
 * Fraction of all relevant items that appear in the top K. `null` when the
 * query has no relevant items at all — an unanswerable/no-ground-truth query
 * is excluded from this metric rather than silently scored as a perfect or
 * zero recall.
 */
export function recallAtK(retrieved: string[], relevance: Relevance, k: number): number | null {
	const total = relevantCount(relevance);
	if (total === 0) return null;
	const top = retrieved.slice(0, k);
	let hit = 0;
	for (const id of top) if (gradeOf(id, relevance) >= 1) hit++;
	return hit / total;
}

/** 1 if any relevant item appears in the top K, else 0. */
export function hitAtK(retrieved: string[], relevance: Relevance, k: number): number {
	const top = retrieved.slice(0, k);
	for (const id of top) if (gradeOf(id, relevance) >= 1) return 1;
	return 0;
}

/**
 * Relevant-retrieved / retrieved, with the denominator capped at
 * min(K, retrieved.length) so a short retrieval isn't penalized for slots it
 * never had a chance to fill. `null` when nothing was retrieved at all —
 * callers count these as a separate "empty retrieval" bucket rather than
 * folding them into the precision average.
 */
export function precisionAtK(retrieved: string[], relevance: Relevance, k: number): number | null {
	if (retrieved.length === 0) return null;
	const top = retrieved.slice(0, k);
	let hit = 0;
	for (const id of top) if (gradeOf(id, relevance) >= 1) hit++;
	return hit / Math.min(k, retrieved.length);
}

/** 1/rank of the first relevant item in the top K (1-indexed rank); 0 if none is found. */
export function reciprocalRankAtK(retrieved: string[], relevance: Relevance, k: number): number {
	const top = retrieved.slice(0, k);
	for (let i = 0; i < top.length; i++) {
		if (gradeOf(top[i], relevance) >= 1) return 1 / (i + 1);
	}
	return 0;
}

/**
 * Graded nDCG@K: gain(g, i) = (2^g - 1) / log2(i + 2) for 0-indexed position
 * i, DCG summed over the top K retrieved, IDCG summed over ALL of the
 * query's relevance grades sorted descending and truncated at K. `null` when
 * the query has no relevant items (IDCG would be 0 — undefined, not a real
 * zero score).
 */
export function ndcgAtK(retrieved: string[], relevance: Relevance, k: number): number | null {
	const total = relevantCount(relevance);
	if (total === 0) return null;
	const top = retrieved.slice(0, k);
	let dcg = 0;
	for (let i = 0; i < top.length; i++) {
		const g = gradeOf(top[i], relevance);
		if (g > 0) dcg += (Math.pow(2, g) - 1) / Math.log2(i + 2);
	}
	const idealGrades = [...relevance.values()].sort((a, b) => b - a).slice(0, k);
	let idcg = 0;
	for (let i = 0; i < idealGrades.length; i++) {
		const g = idealGrades[i];
		if (g > 0) idcg += (Math.pow(2, g) - 1) / Math.log2(i + 2);
	}
	if (idcg === 0) return null;
	return dcg / idcg;
}

/**
 * Ranked, deduped chunk-id list -> ranked, deduped file-path list, preserving
 * each path's first occurrence. `pathOf` returns undefined for an id the
 * caller can't resolve (e.g. an anchor that no longer exists) — such ids are
 * dropped rather than surfacing as `undefined` in the result.
 */
export function dedupeToFiles(retrievedChunkIds: string[], pathOf: (id: string) => string | undefined): string[] {
	const seen = new Set<string>();
	const paths: string[] = [];
	for (const id of retrievedChunkIds) {
		const p = pathOf(id);
		if (p === undefined || seen.has(p)) continue;
		seen.add(p);
		paths.push(p);
	}
	return paths;
}

/**
 * Collapses chunk-level qrels into file-level qrels (max grade per path), so
 * the same recall/precision/nDCG functions can be reused for file-level
 * metrics against a `dedupeToFiles`-produced retrieval list.
 */
export function chunkQrelsToFileQrels(chunkRelevance: Relevance, pathOf: (id: string) => string | undefined): Relevance {
	const filePathGrades: Relevance = new Map();
	for (const [id, grade] of chunkRelevance) {
		const p = pathOf(id);
		if (p === undefined) continue;
		const current = filePathGrades.get(p);
		if (current === undefined || grade > current) filePathGrades.set(p, grade);
	}
	return filePathGrades;
}

/** Mean of the non-null values, plus how many were counted (n < values.length when some were null). */
export function mean(values: (number | null)[]): { mean: number; n: number } {
	const nums = values.filter((v): v is number => v !== null);
	if (nums.length === 0) return { mean: 0, n: 0 };
	const sum = nums.reduce((a, b) => a + b, 0);
	return { mean: sum / nums.length, n: nums.length };
}

/**
 * mulberry32: a tiny, fast, seedable PRNG (public-domain algorithm). Used
 * instead of Math.random() so bootstrap/randomization results are
 * reproducible given the same seed — a hard requirement for a benchmark
 * whose whole point is comparable, re-runnable numbers.
 */
function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return function (): number {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export interface BootstrapOptions {
	iters?: number;
	alpha?: number;
	seed?: number;
}

export interface BootstrapCI {
	mean: number;
	lo: number;
	hi: number;
}

/**
 * Percentile bootstrap confidence interval for the mean of `values`. Empty
 * input returns NaN for all three fields rather than throwing, since a
 * metric slice can legitimately be empty (e.g. no queries fell into some
 * bucket) and callers should be able to check `Number.isNaN(mean)` instead
 * of wrapping every call in try/catch.
 */
export function bootstrapCI(values: number[], options: BootstrapOptions = {}): BootstrapCI {
	const { iters = 10000, alpha = 0.05, seed = 1 } = options;
	const n = values.length;
	if (n === 0) return { mean: NaN, lo: NaN, hi: NaN };
	const observedMean = values.reduce((a, b) => a + b, 0) / n;
	const rand = mulberry32(seed);
	const means = new Array<number>(iters);
	for (let iter = 0; iter < iters; iter++) {
		let sum = 0;
		for (let i = 0; i < n; i++) {
			sum += values[Math.floor(rand() * n)];
		}
		means[iter] = sum / n;
	}
	means.sort((a, b) => a - b);
	const loIdx = Math.max(0, Math.floor((alpha / 2) * iters));
	const hiIdx = Math.min(iters - 1, Math.ceil((1 - alpha / 2) * iters) - 1);
	return { mean: observedMean, lo: means[loIdx], hi: means[hiIdx] };
}

export interface RandomizationOptions {
	iters?: number;
	seed?: number;
}

/**
 * Two-sided paired randomization (sign-flip) test for mean(a - b): the null
 * hypothesis is that each pair's sign is arbitrary, so the observed
 * |mean diff| is compared against the distribution of |mean diff| under
 * `iters` random sign flips of every pairwise difference. p is the fraction
 * of flips at least as extreme as the observed statistic.
 */
export function pairedRandomizationTest(a: number[], b: number[], options: RandomizationOptions = {}): number {
	if (a.length !== b.length) {
		throw new Error(`pairedRandomizationTest: a and b must have the same length (got ${a.length} and ${b.length})`);
	}
	const { iters = 10000, seed = 1 } = options;
	const n = a.length;
	const diffs = a.map((v, i) => v - b[i]);
	const observed = Math.abs(diffs.reduce((s, d) => s + d, 0) / n);
	const rand = mulberry32(seed);
	let atLeastAsExtreme = 0;
	for (let iter = 0; iter < iters; iter++) {
		let sum = 0;
		for (let i = 0; i < n; i++) {
			sum += (rand() < 0.5 ? 1 : -1) * diffs[i];
		}
		const stat = Math.abs(sum / n);
		if (stat >= observed - 1e-12) atLeastAsExtreme++;
	}
	return atLeastAsExtreme / iters;
}
