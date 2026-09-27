/**
 * Pure human/judge agreement statistics — Spearman rank correlation and
 * quadratic-weighted Cohen's kappa — for bench/human-agreement.ts's CLI.
 * No DB/network/`$lib` imports so this runs under plain `tsx` and is unit
 * testable with hand-built fixtures.
 */

/** Average (competition-style) ranks, tied values sharing the mean rank of
 * their positions — the standard fix for Spearman with ties. */
function ranks(values: number[]): number[] {
	const idx = values.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
	const out = new Array<number>(values.length);
	let i = 0;
	while (i < idx.length) {
		let j = i;
		while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
		const avgRank = (i + j) / 2 + 1; // 1-indexed
		for (let k = i; k <= j; k++) out[idx[k][1]] = avgRank;
		i = j + 1;
	}
	return out;
}

/** Spearman's rho between two equal-length numeric arrays. NaN if either
 * array has fewer than 2 points or zero variance (undefined correlation). */
export function spearman(a: number[], b: number[]): number {
	if (a.length !== b.length) throw new Error(`spearman: length mismatch (${a.length} vs ${b.length})`);
	const n = a.length;
	if (n < 2) return NaN;
	const ra = ranks(a);
	const rb = ranks(b);
	const meanA = ra.reduce((s, v) => s + v, 0) / n;
	const meanB = rb.reduce((s, v) => s + v, 0) / n;
	let cov = 0;
	let varA = 0;
	let varB = 0;
	for (let i = 0; i < n; i++) {
		const da = ra[i] - meanA;
		const db = rb[i] - meanB;
		cov += da * db;
		varA += da * da;
		varB += db * db;
	}
	if (varA === 0 || varB === 0) return NaN;
	return cov / Math.sqrt(varA * varB);
}

/**
 * Quadratic-weighted Cohen's kappa for two raters scoring the same items on
 * an integer scale [min, max] (1-5 for correctness/relevance here). Standard
 * formula: weight(i,j) = (i-j)^2 / (max-min)^2, kappa = 1 - sum(w*O)/sum(w*E).
 */
export function quadraticWeightedKappa(a: number[], b: number[], min = 1, max = 5): number {
	if (a.length !== b.length) throw new Error(`quadraticWeightedKappa: length mismatch (${a.length} vs ${b.length})`);
	const n = a.length;
	if (n === 0) return NaN;
	const k = max - min + 1;
	const observed = Array.from({ length: k }, () => new Array(k).fill(0));
	const histA = new Array(k).fill(0);
	const histB = new Array(k).fill(0);
	for (let i = 0; i < n; i++) {
		const ai = Math.round(a[i]) - min;
		const bi = Math.round(b[i]) - min;
		if (ai < 0 || ai >= k || bi < 0 || bi >= k) throw new Error(`quadraticWeightedKappa: value out of [${min}, ${max}] range`);
		observed[ai][bi]++;
		histA[ai]++;
		histB[bi]++;
	}
	const range2 = (k - 1) * (k - 1);
	let numerator = 0;
	let denominator = 0;
	for (let i = 0; i < k; i++) {
		for (let j = 0; j < k; j++) {
			const w = ((i - j) * (i - j)) / range2;
			const expected = (histA[i] * histB[j]) / n;
			numerator += w * observed[i][j];
			denominator += w * expected;
		}
	}
	if (denominator === 0) return 1; // both raters perfectly agree with zero expected disagreement
	return 1 - numerator / denominator;
}

export interface AgreementPair {
	human: number;
	judge: number;
}

export interface AgreementReport {
	n: number;
	spearman: number;
	quadraticWeightedKappa: number;
}

export function computeAgreement(pairs: AgreementPair[], min = 1, max = 5): AgreementReport {
	const humanVals = pairs.map((p) => p.human);
	const judgeVals = pairs.map((p) => p.judge);
	return {
		n: pairs.length,
		spearman: spearman(humanVals, judgeVals),
		quadraticWeightedKappa: quadraticWeightedKappa(humanVals, judgeVals, min, max)
	};
}
