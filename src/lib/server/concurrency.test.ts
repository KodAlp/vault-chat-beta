import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runPool } from './concurrency';

test('runPool never exceeds the limit and returns every result in input order', async () => {
	let active = 0;
	let peak = 0;
	const items = Array.from({ length: 20 }, (_, i) => i);
	const results = await runPool(items, 4, async (n) => {
		active++;
		peak = Math.max(peak, active);
		// Later items finish sooner, so completion order differs from input order.
		await new Promise((r) => setTimeout(r, (20 - n) % 5));
		active--;
		return n * 2;
	});
	assert.equal(peak, 4);
	assert.deepEqual(results, items.map((n) => n * 2));
});

test('runPool handles empty input and limits larger than the item count', async () => {
	assert.deepEqual(await runPool([], 4, async () => 1), []);
	assert.deepEqual(await runPool([1, 2], 10, async (n) => n + 1), [2, 3]);
});

test('runPool stops starting new items after a failure and rejects with the first error', async () => {
	const started: number[] = [];
	await assert.rejects(
		runPool([1, 2, 3, 4, 5, 6], 2, async (n) => {
			started.push(n);
			if (n === 2) throw new Error('boom');
			await new Promise((r) => setTimeout(r, 5));
			return n;
		}),
		/boom/
	);
	assert.ok(started.length < 6);
});
