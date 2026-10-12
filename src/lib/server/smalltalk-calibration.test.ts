import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {
	MAX_USABLE_PERSONAL,
	MIN_PROBES,
	PROBE_QUESTIONS,
	calibrationSignature,
	deriveThresholds,
	worstProbeSimilarity
} from './smalltalk-calibration';
import { DEFAULT_THRESHOLDS, decideSmallTalk, normalize, type GatePhrase } from './smalltalk-gate';
import { initSmallTalkSchema, loadCalibration, saveCalibration } from './smalltalk-store';
import { SMALLTALK_SEEDS } from './smalltalk-seeds';

// Synthetic geometry: seed is [1,0,0]; a vector at similarity `s` to it is [s, sqrt(1-s^2), 0].
const SEED = [1, 0, 0];
const at = (s: number) => [s, Math.sqrt(1 - s * s), 0];
const probes = (worst: number, n = MIN_PROBES) => Array.from({ length: n }, (_, i) => at(worst - i * 0.01));

test('worstProbeSimilarity is the highest probe-to-seed cosine', () => {
	const w = worstProbeSimilarity([SEED], [at(0.3), at(0.7), at(0.5)]);
	assert.ok(Math.abs(w - 0.7) < 1e-6);
	assert.equal(worstProbeSimilarity([], [at(0.5)]), -1);
});

test('a model whose probes are all far from seeds gets exactly the bge-m3 thresholds (floor)', () => {
	const t = deriveThresholds([SEED], probes(0.5))!;
	assert.deepEqual({ ...t, seedMinCorpusDist: undefined }, { ...DEFAULT_THRESHOLDS, seedMinCorpusDist: undefined });
	assert.equal(t.seedMinCorpusDist, null);
});

test('a shifted model (unrelated texts at ~0.80) gets thresholds above the worst probe with margin', () => {
	const t = deriveThresholds([SEED], probes(0.8))!;
	assert.ok(t.seedSim >= 0.8 + 0.07 - 1e-9);
	assert.ok(t.personalSim >= 0.8 + 0.1 - 1e-9);
	assert.ok(t.seedSim <= t.personalSim && t.personalSim < t.negativeSim && t.negativeSim < t.duplicateSim);
	// no probe would be flagged under the derived thresholds; a near-copy of a seed is
	const seedPhrase: GatePhrase = { id: 1, source: 'seed', kind: 'smalltalk', blocked: false, vec: normalize(SEED) };
	for (const p of probes(0.8)) assert.equal(decideSmallTalk(p, 0.9, [seedPhrase], t).smallTalk, false);
	assert.equal(decideSmallTalk(at(0.97), 0.9, [seedPhrase], t).smallTalk, true);
});

test('a model that cannot separate probes from seeds is refused (gate stays off)', () => {
	assert.equal(deriveThresholds([SEED], probes(0.9)), null);
	assert.ok(0.9 + 0.1 > MAX_USABLE_PERSONAL);
});

test('too few probes, no seeds or mismatched dims are refused', () => {
	assert.equal(deriveThresholds([SEED], probes(0.5, MIN_PROBES - 1)), null);
	assert.equal(deriveThresholds([], probes(0.5)), null);
	assert.equal(deriveThresholds([SEED], [...probes(0.5), [1, 0]]), null);
});

test('derived thresholds never drop below the bge-m3 ones', () => {
	for (const worst of [-0.2, 0.1, 0.4, 0.6, 0.75, 0.8]) {
		const t = deriveThresholds([SEED], probes(worst))!;
		assert.ok(t.seedSim >= DEFAULT_THRESHOLDS.seedSim, String(worst));
		assert.ok(t.personalSim >= DEFAULT_THRESHOLDS.personalSim);
		assert.ok(t.negativeSim >= DEFAULT_THRESHOLDS.negativeSim);
		assert.ok(t.duplicateSim >= DEFAULT_THRESHOLDS.duplicateSim);
	}
});

test('probe list is non-trivial and duplicates the seeds nowhere', () => {
	assert.ok(PROBE_QUESTIONS.length >= MIN_PROBES);
	for (const q of PROBE_QUESTIONS) assert.ok(!SMALLTALK_SEEDS.includes(q), q);
});

test('calibration persists per model and is dropped when the signature changes', () => {
	const db = new Database(':memory:');
	initSmallTalkSchema(db);
	const t = deriveThresholds([SEED], probes(0.8))!;
	const sig = calibrationSignature(SMALLTALK_SEEDS);
	assert.equal(loadCalibration(db, 'm', sig), null);
	saveCalibration(db, 'm', sig, t);
	assert.deepEqual(loadCalibration(db, 'm', sig), t);
	assert.equal(loadCalibration(db, 'other', sig), null);
	assert.equal(loadCalibration(db, 'm', calibrationSignature([...SMALLTALK_SEEDS, 'yeni'])), null);
});
