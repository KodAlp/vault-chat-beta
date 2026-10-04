import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatGroupKey, groupChatsByDate } from './chat-groups';

const now = new Date(2026, 9, 15, 14, 0, 0); // 15 Oct 2026, local

function daysAgo(n: number, hour = 9): string {
	return new Date(2026, 9, 15 - n, hour, 0, 0).toISOString();
}

test('chatGroupKey buckets by local calendar day', () => {
	assert.equal(chatGroupKey(daysAgo(0, 1), now), 'today');
	assert.equal(chatGroupKey(daysAgo(1, 23), now), 'yesterday');
	assert.equal(chatGroupKey(daysAgo(2), now), 'last7');
	assert.equal(chatGroupKey(daysAgo(7), now), 'last7');
	assert.equal(chatGroupKey(daysAgo(8), now), 'last30');
	assert.equal(chatGroupKey(daysAgo(30), now), 'last30');
	assert.equal(chatGroupKey(daysAgo(31), now), 'older');
});

test('future and unparseable dates never vanish', () => {
	assert.equal(chatGroupKey(daysAgo(-3), now), 'today');
	assert.equal(chatGroupKey('not-a-date', now), 'older');
});

test('groupChatsByDate orders buckets, sorts newest first and omits empty buckets', () => {
	const chats = [
		{ id: 'old', updated_at: daysAgo(90) },
		{ id: 'b', updated_at: daysAgo(0, 8) },
		{ id: 'y', updated_at: daysAgo(1) },
		{ id: 'a', updated_at: daysAgo(0, 12) }
	];
	const groups = groupChatsByDate(chats, now);
	assert.deepEqual(groups.map((g) => g.key), ['today', 'yesterday', 'older']);
	assert.deepEqual(groups[0].items.map((c) => c.id), ['a', 'b']);
});

test('groupChatsByDate of an empty list is empty', () => {
	assert.deepEqual(groupChatsByDate([], now), []);
});
