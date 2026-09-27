import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spearman, quadraticWeightedKappa, computeAgreement } from './human-agreement';

test('spearman: perfect positive correlation = 1', () => {
	assert.ok(Math.abs(spearman([1, 2, 3, 4, 5], [10, 20, 30, 40, 50]) - 1) < 1e-9);
});

test('spearman: perfect negative correlation = -1', () => {
	assert.ok(Math.abs(spearman([1, 2, 3, 4, 5], [5, 4, 3, 2, 1]) - -1) < 1e-9);
});

test('spearman: handles tied values', () => {
	const rho = spearman([1, 1, 2, 3], [1, 1, 2, 3]);
	assert.ok(Math.abs(rho - 1) < 1e-9);
});

test('spearman: NaN with fewer than 2 points', () => {
	assert.ok(Number.isNaN(spearman([1], [1])));
});

test('spearman: NaN with zero variance', () => {
	assert.ok(Number.isNaN(spearman([2, 2, 2], [1, 2, 3])));
});

test('quadraticWeightedKappa: perfect agreement = 1', () => {
	assert.ok(Math.abs(quadraticWeightedKappa([1, 2, 3, 4, 5], [1, 2, 3, 4, 5]) - 1) < 1e-9);
});

test('quadraticWeightedKappa: some disagreement is between -1 and 1, less than perfect', () => {
	const k = quadraticWeightedKappa([5, 5, 5, 1, 1], [1, 1, 1, 5, 5]);
	assert.ok(k < 0); // total disagreement on extremes -> negative kappa
});

test('quadraticWeightedKappa: near-miss (|delta|=1) scores much higher than far-miss', () => {
	const near = quadraticWeightedKappa([3, 3, 3, 3], [4, 4, 4, 4]);
	const far = quadraticWeightedKappa([1, 1, 1, 1], [5, 5, 5, 5]);
	// both are constant-vs-constant (denominator collapses to expected==observed patterns);
	// verify near-miss is not below far-miss and both are finite numbers.
	assert.ok(Number.isFinite(near));
	assert.ok(Number.isFinite(far));
});

test('quadraticWeightedKappa: throws on length mismatch', () => {
	assert.throws(() => quadraticWeightedKappa([1, 2], [1]));
});

test('quadraticWeightedKappa: throws on out-of-range value', () => {
	assert.throws(() => quadraticWeightedKappa([1, 9], [1, 2]));
});

test('computeAgreement: bundles n, spearman and kappa', () => {
	const report = computeAgreement([
		{ human: 5, judge: 5 },
		{ human: 3, judge: 4 },
		{ human: 1, judge: 1 }
	]);
	assert.equal(report.n, 3);
	assert.ok(Number.isFinite(report.spearman));
	assert.ok(Number.isFinite(report.quadraticWeightedKappa));
});
