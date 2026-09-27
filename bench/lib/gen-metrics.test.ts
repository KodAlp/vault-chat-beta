import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	faithfulness,
	unsupportedClaimRate,
	hasUnsupportedClaim,
	computeHallucination,
	computeCorrectness,
	computeRelevance,
	computeAbstention,
	computeSmalltalkCompliance,
	computeCitation,
	computeContextRelevance,
	judgedGrade2Chunks,
	computeResponseLanguageCompliance,
	computeTypeAccuracy,
	computePerformance,
	computeSelfConsistency,
	computeSanityCheck,
	percentile,
	type GenItem
} from './gen-metrics';
import type { JudgeResult } from './judge';

function makeJudge(overrides: Partial<JudgeResult> = {}): JudgeResult {
	return {
		claims: [],
		correctness: 5,
		relevance: 5,
		abstained: false,
		answer_language: 'English',
		mentioned_sources: [],
		chunk_relevance: [],
		reason: 'ok',
		...overrides
	};
}

test('faithfulness: fully supported claims = 1.0', () => {
	const claims = [
		{ text: 'a', needs_citation: true, support: [{ chunk: 1, grade: 2 as const }] },
		{ text: 'b', needs_citation: true, support: [{ chunk: 2, grade: 2 as const }] }
	];
	assert.equal(faithfulness(claims), 1.0);
});

test('faithfulness: unsupported claims = 0', () => {
	const claims = [{ text: 'a', needs_citation: true, support: [{ chunk: 1, grade: 0 as const }] }];
	assert.equal(faithfulness(claims), 0);
});

test('faithfulness: mixed grades average correctly (sum/2n)', () => {
	// grade 2 + grade 1 -> (2+1)/(2*2) = 0.75
	const claims = [
		{ text: 'a', needs_citation: true, support: [{ chunk: 1, grade: 2 as const }] },
		{ text: 'b', needs_citation: true, support: [{ chunk: 1, grade: 1 as const }] }
	];
	assert.equal(faithfulness(claims), 0.75);
});

test('faithfulness: no claims -> NaN', () => {
	assert.ok(Number.isNaN(faithfulness([])));
});

test('unsupportedClaimRate and hasUnsupportedClaim', () => {
	const claims = [
		{ text: 'a', needs_citation: true, support: [{ chunk: 1, grade: 0 as const }] },
		{ text: 'b', needs_citation: true, support: [{ chunk: 1, grade: 2 as const }] }
	];
	assert.equal(unsupportedClaimRate(claims), 0.5);
	assert.equal(hasUnsupportedClaim(claims), true);
	assert.equal(hasUnsupportedClaim([{ text: 'c', needs_citation: false, support: [{ chunk: 1, grade: 1 as const }] }]), false);
});

test('computeHallucination: separates answerable vs unanswerable rates', () => {
	const items: GenItem[] = [
		{
			id: '1',
			type: 'direct',
			lang: 'en',
			answerable: true,
			numChunks: 1,
			judge: makeJudge({ claims: [{ text: 'a', needs_citation: true, support: [{ chunk: 1, grade: 0 }] }] })
		},
		{
			id: '2',
			type: 'unanswerable',
			lang: 'en',
			answerable: false,
			numChunks: 0,
			judge: makeJudge({ claims: [{ text: 'a', needs_citation: false, support: [{ chunk: 1, grade: 2 }] }], abstained: true })
		}
	];
	const report = computeHallucination(items);
	assert.equal(report.hallucinationRateAnswerable, 1);
	assert.equal(report.hallucinationRateUnanswerable, 0);
});

test('computeCorrectness: answerable-only, share>=4', () => {
	const items: GenItem[] = [
		{ id: '1', type: 'direct', lang: 'en', answerable: true, numChunks: 1, judge: makeJudge({ correctness: 5 }) },
		{ id: '2', type: 'direct', lang: 'en', answerable: true, numChunks: 1, judge: makeJudge({ correctness: 2 }) },
		{ id: '3', type: 'unanswerable', lang: 'en', answerable: false, numChunks: 0, judge: makeJudge({ correctness: 1 }) }
	];
	const report = computeCorrectness(items);
	assert.equal(report.mean.n, 2);
	assert.equal(report.shareAtLeast4.mean, 0.5);
});

test('computeRelevance: includes all judged items', () => {
	const items: GenItem[] = [
		{ id: '1', type: 'direct', lang: 'en', answerable: true, numChunks: 1, judge: makeJudge({ relevance: 5 }) },
		{ id: '2', type: 'unanswerable', lang: 'en', answerable: false, numChunks: 0, judge: makeJudge({ relevance: 4 }) }
	];
	const report = computeRelevance(items);
	assert.equal(report.mean.n, 2);
});

test('computeAbstention: accuracy on unanswerable, false-abstention on answerable', () => {
	const items: GenItem[] = [
		{ id: '1', type: 'unanswerable', lang: 'en', answerable: false, numChunks: 0, judge: makeJudge({ abstained: true }) },
		{ id: '2', type: 'unanswerable', lang: 'en', answerable: false, numChunks: 0, judge: makeJudge({ abstained: false }) },
		{ id: '3', type: 'direct', lang: 'en', answerable: true, numChunks: 1, judge: makeJudge({ abstained: true }) },
		{ id: '4', type: 'direct', lang: 'en', answerable: true, numChunks: 1, judge: makeJudge({ abstained: false }) }
	];
	const report = computeAbstention(items);
	assert.equal(report.abstentionAccuracy, 0.5);
	assert.equal(report.falseAbstentionRate, 0.5);
});

test('computeSmalltalkCompliance', () => {
	const items: GenItem[] = [
		{ id: '1', type: 'smalltalk', lang: 'en', answerable: false, numChunks: 0, judge: makeJudge({ claims: [], mentioned_sources: [] }) },
		{
			id: '2',
			type: 'smalltalk',
			lang: 'en',
			answerable: false,
			numChunks: 0,
			judge: makeJudge({ claims: [{ text: 'x', needs_citation: true, support: [] }] })
		}
	];
	assert.equal(computeSmalltalkCompliance(items), 0.5);
	assert.equal(computeSmalltalkCompliance([]), null);
});

test('computeCitation: source-list precision, recall, mention precision, entailment distribution', () => {
	const items: GenItem[] = [
		{
			id: '1',
			type: 'direct',
			lang: 'en',
			answerable: true,
			numChunks: 2,
			judge: makeJudge({
				claims: [
					{ text: 'a', needs_citation: true, support: [{ chunk: 1, grade: 2 }] },
					{ text: 'b', needs_citation: true, support: [{ chunk: 2, grade: 0 }] }
				],
				mentioned_sources: [{ mention: 'note A', chunk: 1, supports: true }, { mention: 'note B', chunk: 2, supports: false }]
			})
		}
	];
	const report = computeCitation(items);
	assert.equal(report.sourceListPrecision.mean, 0.5); // 1 of 2 shown chunks supported a claim
	assert.equal(report.citationRecall.mean, 0.5); // 1 of 2 citation-needing claims supported
	assert.equal(report.mentionPrecision.mean, 0.5);
	assert.equal(report.entailmentDistribution.total, 2);
	assert.equal(report.entailmentDistribution.grade2, 1);
	assert.equal(report.entailmentDistribution.grade0, 1);
});

test('computeContextRelevance: share of chunk_relevance >= 1', () => {
	const items: GenItem[] = [
		{
			id: '1',
			type: 'direct',
			lang: 'en',
			answerable: true,
			numChunks: 2,
			judge: makeJudge({
				chunk_relevance: [
					{ chunk: 1, grade: 2 },
					{ chunk: 2, grade: 0 }
				]
			})
		}
	];
	assert.equal(computeContextRelevance(items).mean, 0.5);
});

test('judgedGrade2Chunks collects only grade-2 chunk_relevance entries', () => {
	const items: GenItem[] = [
		{
			id: '1',
			type: 'direct',
			lang: 'en',
			answerable: true,
			numChunks: 2,
			judge: makeJudge({
				chunk_relevance: [
					{ chunk: 1, grade: 2 },
					{ chunk: 2, grade: 1 }
				]
			})
		}
	];
	const pooled = judgedGrade2Chunks(items);
	assert.equal(pooled.length, 1);
	assert.equal(pooled[0].chunkIndex, 1);
});

test('computeResponseLanguageCompliance: excludes unreliable detection and smalltalk', () => {
	const items: GenItem[] = [
		{ id: '1', type: 'direct', lang: 'tr', answerable: true, numChunks: 1, judge: makeJudge(), detectedAnswerLang: { reliable: true, iso3: 'tur' } },
		{ id: '2', type: 'direct', lang: 'tr', answerable: true, numChunks: 1, judge: makeJudge(), detectedAnswerLang: { reliable: true, iso3: 'eng' } },
		{ id: '3', type: 'direct', lang: 'tr', answerable: true, numChunks: 1, judge: makeJudge(), detectedAnswerLang: { reliable: false } },
		{ id: '4', type: 'smalltalk', lang: 'tr', answerable: false, numChunks: 0, judge: makeJudge(), detectedAnswerLang: { reliable: true, iso3: 'tur' } }
	];
	const report = computeResponseLanguageCompliance(items);
	assert.equal(report.n, 2); // items 1 and 2 only
	assert.equal(report.mean, 0.5);
});

test('computeTypeAccuracy: correctness>=4 share for a given type', () => {
	const items: GenItem[] = [
		{ id: '1', type: 'multi_hop', lang: 'en', answerable: true, numChunks: 1, judge: makeJudge({ correctness: 4 }) },
		{ id: '2', type: 'multi_hop', lang: 'en', answerable: true, numChunks: 1, judge: makeJudge({ correctness: 2 }) },
		{ id: '3', type: 'direct', lang: 'en', answerable: true, numChunks: 1, judge: makeJudge({ correctness: 5 }) }
	];
	const report = computeTypeAccuracy(items, 'multi_hop');
	assert.equal(report.n, 2);
	assert.equal(report.mean, 0.5);
});

test('percentile: p50/p95 basic sanity', () => {
	assert.equal(percentile([1, 2, 3, 4, 5], 50), 3);
	assert.ok(Number.isNaN(percentile([], 50)));
});

test('computePerformance: p50/p95 for ttft/generation/total/tok-per-sec', () => {
	const report = computePerformance([
		{ ttftMs: 100, generationMs: 1000, totalMs: 1200, tokPerSec: 10 },
		{ ttftMs: 200, generationMs: 2000, totalMs: 2200, tokPerSec: 20 }
	]);
	assert.ok(report.ttftP50 >= 100 && report.ttftP50 <= 200);
	assert.ok(report.generationMsP95 > report.generationMsP50 && report.generationMsP95 <= 2000);
});

test('computeSelfConsistency: exact agreement and within-1 counts', () => {
	const report = computeSelfConsistency([
		{ correctnessA: 4, correctnessB: 4, faithfulnessA: 0.8, faithfulnessB: 0.8 },
		{ correctnessA: 4, correctnessB: 5, faithfulnessA: 0.9, faithfulnessB: 0.7 },
		{ correctnessA: 2, correctnessB: 5, faithfulnessA: 1.0, faithfulnessB: 0.0 }
	]);
	assert.equal(report.n, 3);
	assert.ok(Math.abs(report.exactAgreementCorrectness - 1 / 3) < 1e-9);
	assert.ok(Math.abs(report.withinOneCorrectness - 2 / 3) < 1e-9);
	assert.ok(report.meanAbsDeltaFaithfulness > 0);
});

test('computeSanityCheck: faithfulness must drop after fabricated sentence', () => {
	const report = computeSanityCheck([
		{ faithfulnessBefore: 1.0, faithfulnessAfter: 0.5 },
		{ faithfulnessBefore: 0.8, faithfulnessAfter: 0.4 }
	]);
	assert.equal(report.allDropped, true);
	assert.ok(report.meanDrop > 0);
});

test('computeSanityCheck: flags when a drop did not happen', () => {
	const report = computeSanityCheck([{ faithfulnessBefore: 0.5, faithfulnessAfter: 0.5 }]);
	assert.equal(report.allDropped, false);
});
