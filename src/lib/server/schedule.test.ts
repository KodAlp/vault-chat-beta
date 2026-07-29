import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schedule, newCardSchedule, type CardSchedule } from './schedule';

const NOW = new Date('2026-07-29T12:00:00.000Z');

function baseCard(overrides: Partial<CardSchedule> = {}): CardSchedule {
	return { ease: 2.5, interval_days: 1, due_at: NOW.toISOString(), reps: 0, lapses: 0, ...overrides };
}

test('newCardSchedule starts at ease 2.5, interval 1, due now', () => {
	const card = newCardSchedule(NOW);
	assert.equal(card.ease, 2.5);
	assert.equal(card.interval_days, 1);
	assert.equal(card.due_at, NOW.toISOString());
	assert.equal(card.reps, 0);
	assert.equal(card.lapses, 0);
});

test('again resets interval to 0, decreases ease, sets due_at to now, increments lapses', () => {
	const result = schedule(baseCard({ ease: 2.5, interval_days: 10, reps: 3, lapses: 1 }), 'again', NOW);
	assert.equal(result.interval_days, 0);
	assert.equal(result.ease, 2.3);
	assert.equal(result.due_at, NOW.toISOString());
	assert.equal(result.reps, 3);
	assert.equal(result.lapses, 2);
});

test('again floors ease at 1.3 and never goes lower', () => {
	const nearFloor = schedule(baseCard({ ease: 1.35 }), 'again', NOW);
	assert.equal(nearFloor.ease, 1.3);
	const atFloor = schedule(baseCard({ ease: 1.3 }), 'again', NOW);
	assert.equal(atFloor.ease, 1.3);
});

test('hard multiplies interval by 1.2 and leaves ease unchanged', () => {
	const result = schedule(baseCard({ ease: 2.5, interval_days: 10 }), 'hard', NOW);
	assert.equal(result.interval_days, 12);
	assert.equal(result.ease, 2.5);
	assert.equal(result.due_at, new Date(NOW.getTime() + 12 * 86_400_000).toISOString());
	assert.equal(result.reps, 1);
});

test('good multiplies interval by ease', () => {
	const result = schedule(baseCard({ ease: 2.5, interval_days: 4 }), 'good', NOW);
	assert.equal(result.interval_days, 10);
	assert.equal(result.due_at, new Date(NOW.getTime() + 10 * 86_400_000).toISOString());
});

test('easy multiplies interval by ease times 1.3', () => {
	const result = schedule(baseCard({ ease: 2.5, interval_days: 4 }), 'easy', NOW);
	assert.equal(result.interval_days, Math.round(4 * 2.5 * 1.3));
});

test('hard/good/easy never produce an interval below 1 day', () => {
	for (const grade of ['hard', 'good', 'easy'] as const) {
		const result = schedule(baseCard({ ease: 1.3, interval_days: 0 }), grade, NOW);
		assert.ok(result.interval_days >= 1, `${grade} produced interval ${result.interval_days}`);
	}
});
