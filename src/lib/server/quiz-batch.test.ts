import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitComposition } from './quiz-batch';

function total(c: { mc: number; tf: number; open: number }): number {
	return c.mc + c.tf + c.open;
}

test('a composition smaller than the batch size returns a single batch, unchanged', () => {
	const batches = splitComposition({ mc: 2, tf: 1, open: 1 }, 5);
	assert.deepEqual(batches, [{ mc: 2, tf: 1, open: 1 }]);
});

test('an exact multiple of the batch size splits evenly, mc-first', () => {
	const batches = splitComposition({ mc: 10, tf: 0, open: 0 }, 5);
	assert.deepEqual(batches, [
		{ mc: 5, tf: 0, open: 0 },
		{ mc: 5, tf: 0, open: 0 }
	]);
});

test('a remainder becomes its own final, smaller batch', () => {
	const batches = splitComposition({ mc: 6, tf: 2, open: 2 }, 5);
	// Every batch sums to at most 5, batches cover the whole composition,
	// mc drains first.
	assert.equal(batches.length, 2);
	for (const b of batches) assert.ok(total(b) <= 5);
	const summed = batches.reduce(
		(acc, b) => ({ mc: acc.mc + b.mc, tf: acc.tf + b.tf, open: acc.open + b.open }),
		{ mc: 0, tf: 0, open: 0 }
	);
	assert.deepEqual(summed, { mc: 6, tf: 2, open: 2 });
});

test('a single type larger than the batch size splits into same-type batches', () => {
	const batches = splitComposition({ mc: 0, tf: 0, open: 12 }, 5);
	assert.deepEqual(batches, [
		{ mc: 0, tf: 0, open: 5 },
		{ mc: 0, tf: 0, open: 5 },
		{ mc: 0, tf: 0, open: 2 }
	]);
});

test('a mixed composition fills each batch to the cap before moving to the next type', () => {
	// mc=3 fits alone in batch 1 with room for 2 more -> 2 of the 4 tf.
	// Remaining tf=2 and open=6 then split across the following batches.
	const batches = splitComposition({ mc: 3, tf: 4, open: 6 }, 5);
	for (const b of batches) assert.ok(total(b) <= 5 && total(b) > 0);
	const summed = batches.reduce(
		(acc, b) => ({ mc: acc.mc + b.mc, tf: acc.tf + b.tf, open: acc.open + b.open }),
		{ mc: 0, tf: 0, open: 0 }
	);
	assert.deepEqual(summed, { mc: 3, tf: 4, open: 6 });
});

test('an all-zero composition produces zero batches, not one empty batch', () => {
	assert.deepEqual(splitComposition({ mc: 0, tf: 0, open: 0 }, 5), []);
});

test('a batch size of 1 produces one batch per item', () => {
	const batches = splitComposition({ mc: 1, tf: 1, open: 0 }, 1);
	assert.deepEqual(batches, [
		{ mc: 1, tf: 0, open: 0 },
		{ mc: 0, tf: 1, open: 0 }
	]);
});
