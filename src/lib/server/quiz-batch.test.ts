import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assignSlots, splitCompositionByType } from './quiz-batch';

test('one type per batch, in mc / tf / open order, and the counts add up exactly', () => {
	const batches = splitCompositionByType({ mc: 4, tf: 2, open: 4 }, 5);
	assert.deepEqual(batches, [
		{ type: 'multiple_choice', count: 4 },
		{ type: 'true_false', count: 2 },
		{ type: 'open', count: 4 }
	]);
});

test('a type over the limit is split as evenly as possible, never 5+2', () => {
	assert.deepEqual(splitCompositionByType({ mc: 7, tf: 0, open: 0 }, 5), [
		{ type: 'multiple_choice', count: 4 },
		{ type: 'multiple_choice', count: 3 }
	]);
	const twenty = splitCompositionByType({ mc: 0, tf: 0, open: 20 }, 5);
	assert.deepEqual(twenty.map((b) => b.count), [5, 5, 5, 5]);
	assert.deepEqual(splitCompositionByType({ mc: 11, tf: 0, open: 0 }, 5).map((b) => b.count), [4, 4, 3]);
});

test('every requested question is in exactly one batch, whatever the composition', () => {
	for (const c of [{ mc: 1, tf: 1, open: 1 }, { mc: 20, tf: 20, open: 20 }, { mc: 0, tf: 3, open: 0 }, { mc: 6, tf: 0, open: 9 }]) {
		const b = splitCompositionByType(c, 5);
		assert.equal(b.filter((x) => x.type === 'multiple_choice').reduce((s, x) => s + x.count, 0), c.mc);
		assert.equal(b.filter((x) => x.type === 'true_false').reduce((s, x) => s + x.count, 0), c.tf);
		assert.equal(b.filter((x) => x.type === 'open').reduce((s, x) => s + x.count, 0), c.open);
		assert.ok(b.every((x) => x.count >= 1 && x.count <= 5));
	}
});

test('an empty composition has no batches', () => {
	assert.deepEqual(splitCompositionByType({ mc: 0, tf: 0, open: 0 }, 5), []);
});

test('assignSlots gives every question its own source part while the pool lasts, across batches', () => {
	const pool = Array.from({ length: 12 }, (_, i) => `S${i + 1}`);
	const slots = assignSlots(pool, [4, 2, 4]);
	assert.deepEqual(slots.map((s) => s.length), [4, 2, 4]);
	const flat = slots.flat();
	assert.equal(new Set(flat).size, 10, 'ten questions, ten different source parts');
	assert.deepEqual(slots[0], ['S1', 'S2', 'S3', 'S4']);
});

test('assignSlots wraps around when there are more questions than source parts, and copes with an empty pool', () => {
	assert.deepEqual(assignSlots(['S1', 'S2', 'S3'], [2, 2, 2]), [['S1', 'S2'], ['S3', 'S1'], ['S2', 'S3']]);
	assert.deepEqual(assignSlots([], [2, 1]), [[], []]);
	assert.deepEqual(assignSlots(['S1'], []), []);
});
