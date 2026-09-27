/**
 * Generation-benchmark metrics (bench/run-generation.ts) — pure functions
 * over already-judged items. No DB, no network, no `$lib`/`$env` imports:
 * gen-metrics.test.ts exercises every formula with hand-built fixtures.
 *
 * Every "item" here pairs one golden question with the SUT's answer, the
 * judge's structured verdict (or none, if --no-judge or judge_failed), the
 * retrieved chunks shown, and this item's golden `type`/`lang`/`answerable`.
 * bootstrapCI/mean are reused from bench/lib/metrics.ts so aggregate CIs use
 * the exact same seeded bootstrap as the retrieval benchmark.
 */
import { bootstrapCI, mean } from './metrics';
import type { JudgeResult } from './judge';

export interface GenItem {
	id: string;
	type: string;
	lang: string;
	answerable: boolean;
	/** Number of chunks actually shown to the SUT for this item (may be 0). */
	numChunks: number;
	judge?: JudgeResult;
	judgeFailed?: boolean;
	/** Detected language of the generated answer (response-language.ts's
	 * detectReliable), independent of the judge's own answer_language guess. */
	detectedAnswerLang?: { reliable: boolean; iso3?: string };
}

export interface Summary {
	mean: number;
	n: number;
	lo: number;
	hi: number;
}

export function summarize(values: number[], seed = 1): Summary {
	if (values.length === 0) return { mean: NaN, n: 0, lo: NaN, hi: NaN };
	const ci = bootstrapCI(values, { seed });
	return { mean: ci.mean, n: values.length, lo: ci.lo, hi: ci.hi };
}

function judged(items: GenItem[]): (GenItem & { judge: JudgeResult })[] {
	return items.filter((i): i is GenItem & { judge: JudgeResult } => i.judge !== undefined && !i.judgeFailed);
}

// ---------------------------------------------------------------------------
// Faithfulness / hallucination
// ---------------------------------------------------------------------------

/** max grade across a claim's support list, 0 if the list is empty. */
function maxSupport(claim: JudgeResult['claims'][number]): number {
	return claim.support.reduce((m, s) => Math.max(m, s.grade), 0);
}

/** Faithfulness = sum(maxSupport(claim)) / (2 * #claims) over ALL claims
 * (not just ones needing citation) — 1.0 when every claim is grade-2
 * supported, 0 when every claim is unsupported. NaN for an answer with zero
 * claims (nothing to be unfaithful about — excluded from the aggregate mean
 * by the caller, same convention as bench/lib/metrics.ts's recall/nDCG). */
export function faithfulness(claims: JudgeResult['claims']): number {
	if (claims.length === 0) return NaN;
	const total = claims.reduce((s, c) => s + maxSupport(c), 0);
	return total / (2 * claims.length);
}

export function unsupportedClaimRate(claims: JudgeResult['claims']): number {
	if (claims.length === 0) return NaN;
	const unsupported = claims.filter((c) => maxSupport(c) === 0).length;
	return unsupported / claims.length;
}

export function hasUnsupportedClaim(claims: JudgeResult['claims']): boolean {
	return claims.some((c) => maxSupport(c) === 0);
}

export interface HallucinationReport {
	faithfulness: Summary;
	unsupportedClaimRate: Summary;
	hallucinationRateAnswerable: number | null;
	hallucinationRateUnanswerable: number | null;
}

export function computeHallucination(items: GenItem[]): HallucinationReport {
	const j = judged(items);
	const withClaims = j.filter((i) => i.judge.claims.length > 0);
	const faithVals = withClaims.map((i) => faithfulness(i.judge.claims));
	const unsupVals = withClaims.map((i) => unsupportedClaimRate(i.judge.claims));

	const answerable = j.filter((i) => i.answerable);
	const unanswerable = j.filter((i) => !i.answerable);
	const hallRate = (arr: typeof j) =>
		arr.length === 0 ? null : arr.filter((i) => hasUnsupportedClaim(i.judge.claims)).length / arr.length;

	return {
		faithfulness: summarize(faithVals),
		unsupportedClaimRate: summarize(unsupVals),
		hallucinationRateAnswerable: hallRate(answerable),
		hallucinationRateUnanswerable: hallRate(unanswerable)
	};
}

// ---------------------------------------------------------------------------
// Correctness / relevance
// ---------------------------------------------------------------------------

export interface ScoreReport {
	mean: Summary;
	shareAtLeast4: Summary;
}

function scoreReport(scores: number[]): ScoreReport {
	return { mean: summarize(scores), shareAtLeast4: summarize(scores.map((s) => (s >= 4 ? 1 : 0))) };
}

export function computeCorrectness(items: GenItem[]): ScoreReport {
	const j = judged(items).filter((i) => i.answerable);
	return scoreReport(j.map((i) => i.judge.correctness));
}

export function computeRelevance(items: GenItem[]): ScoreReport {
	const j = judged(items);
	return scoreReport(j.map((i) => i.judge.relevance));
}

// ---------------------------------------------------------------------------
// Abstention
// ---------------------------------------------------------------------------

export interface AbstentionReport {
	/** unanswerable items the model correctly abstained on. */
	abstentionAccuracy: number | null;
	/** answerable items the model wrongly abstained on. */
	falseAbstentionRate: number | null;
}

export function computeAbstention(items: GenItem[]): AbstentionReport {
	const j = judged(items);
	const unanswerable = j.filter((i) => !i.answerable && i.type !== 'smalltalk');
	const answerable = j.filter((i) => i.answerable);
	return {
		abstentionAccuracy: unanswerable.length === 0 ? null : unanswerable.filter((i) => i.judge.abstained).length / unanswerable.length,
		falseAbstentionRate: answerable.length === 0 ? null : answerable.filter((i) => i.judge.abstained).length / answerable.length
	};
}

/** Share of smalltalk items with zero claims needing citation and no
 * mentioned sources — the model treated it as pure smalltalk, not a
 * pretext to cite vault content. */
export function computeSmalltalkCompliance(items: GenItem[]): number | null {
	const j = judged(items).filter((i) => i.type === 'smalltalk');
	if (j.length === 0) return null;
	const compliant = j.filter((i) => i.judge.claims.every((c) => !c.needs_citation) && i.judge.mentioned_sources.length === 0).length;
	return compliant / j.length;
}

// ---------------------------------------------------------------------------
// Citation ("adapted" — no bracket tags; sources are the shown-chunk list +
// prose mentions of topic titles)
// ---------------------------------------------------------------------------

export interface CitationReport {
	/** Of the chunks actually shown, share that support >=1 claim at grade>=1. */
	sourceListPrecision: Summary;
	/** Of claims needing citation, share supported (grade>=1) by some shown chunk. */
	citationRecall: Summary;
	/** Of prose mentions of a source, share where supports=true. */
	mentionPrecision: Summary;
	/** Distribution of claim-support grades (0/1/2) across all support entries. */
	entailmentDistribution: { grade0: number; grade1: number; grade2: number; total: number };
}

function shownChunksSupported(item: GenItem & { judge: JudgeResult }): number {
	const supportedChunks = new Set<number>();
	for (const c of item.judge.claims) for (const s of c.support) if (s.grade >= 1) supportedChunks.add(s.chunk);
	return supportedChunks.size;
}

export function computeCitation(items: GenItem[]): CitationReport {
	const j = judged(items);

	const sourceListPrecisions = j.filter((i) => i.numChunks > 0).map((i) => shownChunksSupported(i) / i.numChunks);

	const withCitationClaims = j.flatMap((i) => i.judge.claims.filter((c) => c.needs_citation).map((c) => (maxSupport(c) >= 1 ? 1 : 0)));

	const mentions = j.flatMap((i) => i.judge.mentioned_sources);
	const mentionPrecisions = mentions.map((m) => (m.supports ? 1 : 0));

	const dist = { grade0: 0, grade1: 0, grade2: 0, total: 0 };
	for (const i of j) {
		for (const c of i.judge.claims) {
			for (const s of c.support) {
				dist.total++;
				if (s.grade === 0) dist.grade0++;
				else if (s.grade === 1) dist.grade1++;
				else dist.grade2++;
			}
		}
	}

	return {
		sourceListPrecision: summarize(sourceListPrecisions),
		citationRecall: summarize(withCitationClaims),
		mentionPrecision: summarize(mentionPrecisions),
		entailmentDistribution: dist
	};
}

// ---------------------------------------------------------------------------
// Context relevance + judged pooling
// ---------------------------------------------------------------------------

export function computeContextRelevance(items: GenItem[]): Summary {
	const j = judged(items);
	const grades = j.flatMap((i) => i.judge.chunk_relevance.map((c) => (c.grade >= 1 ? 1 : 0)));
	return summarize(grades);
}

export interface PooledQrelCandidate {
	itemId: string;
	chunkIndex: number;
	grade: 2;
}

/** Chunks the judge graded 2 (directly relevant) for their item — the caller
 * (run-generation.ts) cross-references these against the golden set's own
 * qrels and writes the ones NOT already present to pooled-qrels.jsonl, along
 * with the chunk's own anchor/path/heading (which this pure function does not
 * have — it only knows the judge's 1-based chunk index). */
export function judgedGrade2Chunks(items: GenItem[]): PooledQrelCandidate[] {
	const out: PooledQrelCandidate[] = [];
	for (const i of judged(items)) {
		for (const c of i.judge.chunk_relevance) {
			if (c.grade === 2) out.push({ itemId: i.id, chunkIndex: c.chunk, grade: 2 });
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// Response-language compliance
// ---------------------------------------------------------------------------

/** iso3 codes this benchmark's golden `lang` field maps to — 'tr'/'en' are
 * the only two golden.ts LANGS values today. */
const GOLDEN_LANG_TO_ISO3: Record<string, string> = { tr: 'tur', en: 'eng' };

export function computeResponseLanguageCompliance(items: GenItem[]): Summary {
	const eligible = items.filter((i) => {
		if (i.type === 'smalltalk') return false;
		if (!i.detectedAnswerLang?.reliable) return false;
		return GOLDEN_LANG_TO_ISO3[i.lang] !== undefined;
	});
	const compliance = eligible.map((i) => (i.detectedAnswerLang!.iso3 === GOLDEN_LANG_TO_ISO3[i.lang] ? 1 : 0));
	return summarize(compliance);
}

// ---------------------------------------------------------------------------
// Multi-hop / cross-document accuracy
// ---------------------------------------------------------------------------

export function computeTypeAccuracy(items: GenItem[], type: string): Summary {
	const j = judged(items).filter((i) => i.type === type);
	return summarize(j.map((i) => (i.judge.correctness >= 4 ? 1 : 0)));
}

// ---------------------------------------------------------------------------
// Performance
// ---------------------------------------------------------------------------

export interface TimingRecord {
	ttftMs?: number;
	generationMs: number;
	totalMs: number;
	tokPerSec?: number;
}

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

export interface PerformanceReport {
	ttftP50: number;
	ttftP95: number;
	generationMsP50: number;
	generationMsP95: number;
	totalMsP50: number;
	totalMsP95: number;
	tokPerSecP50: number;
	tokPerSecP95: number;
}

export function computePerformance(timings: TimingRecord[]): PerformanceReport {
	const ttft = timings.map((t) => t.ttftMs).filter((v): v is number => v !== undefined);
	const gen = timings.map((t) => t.generationMs);
	const total = timings.map((t) => t.totalMs);
	const tps = timings.map((t) => t.tokPerSec).filter((v): v is number => v !== undefined);
	return {
		ttftP50: percentile(ttft, 50),
		ttftP95: percentile(ttft, 95),
		generationMsP50: percentile(gen, 50),
		generationMsP95: percentile(gen, 95),
		totalMsP50: percentile(total, 50),
		totalMsP95: percentile(total, 95),
		tokPerSecP50: percentile(tps, 50),
		tokPerSecP95: percentile(tps, 95)
	};
}

// ---------------------------------------------------------------------------
// Self-consistency (--rejudge) and sanity-check (--sanity) helpers
// ---------------------------------------------------------------------------

export interface SelfConsistencyPair {
	correctnessA: number;
	correctnessB: number;
	faithfulnessA: number;
	faithfulnessB: number;
}

export interface SelfConsistencyReport {
	exactAgreementCorrectness: number;
	withinOneCorrectness: number;
	meanAbsDeltaFaithfulness: number;
	n: number;
}

export function computeSelfConsistency(pairs: SelfConsistencyPair[]): SelfConsistencyReport {
	if (pairs.length === 0) return { exactAgreementCorrectness: NaN, withinOneCorrectness: NaN, meanAbsDeltaFaithfulness: NaN, n: 0 };
	const exact = pairs.filter((p) => p.correctnessA === p.correctnessB).length;
	const withinOne = pairs.filter((p) => Math.abs(p.correctnessA - p.correctnessB) <= 1).length;
	const faithDeltas = pairs
		.map((p) => Math.abs(p.faithfulnessA - p.faithfulnessB))
		.filter((v) => !Number.isNaN(v));
	return {
		exactAgreementCorrectness: exact / pairs.length,
		withinOneCorrectness: withinOne / pairs.length,
		meanAbsDeltaFaithfulness: faithDeltas.length ? mean(faithDeltas).mean : NaN,
		n: pairs.length
	};
}

export interface SanityPair {
	faithfulnessBefore: number;
	faithfulnessAfter: number;
}

export interface SanityReport {
	meanDrop: number;
	allDropped: boolean;
	n: number;
}

/** The --sanity check appends a fabricated unsupported sentence to an
 * answerable item's SUT answer and re-judges both — faithfulness MUST drop
 * for a working judge; this just computes the drop, run-generation.ts
 * decides what to print/warn about. */
export function computeSanityCheck(pairs: SanityPair[]): SanityReport {
	if (pairs.length === 0) return { meanDrop: NaN, allDropped: false, n: 0 };
	const drops = pairs.map((p) => p.faithfulnessBefore - p.faithfulnessAfter);
	return { meanDrop: mean(drops).mean, allDropped: drops.every((d) => d > 0), n: pairs.length };
}
