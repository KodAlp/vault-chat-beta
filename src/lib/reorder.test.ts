import { test } from 'node:test';
import assert from 'node:assert/strict';
import { moveItem } from './reorder';

test('moveItem moves forward and backward', () => {
	assert.deepEqual(moveItem(['a', 'b', 'c', 'd'], 0, 2), ['b', 'c', 'a', 'd']);
	assert.deepEqual(moveItem(['a', 'b', 'c', 'd'], 3, 1), ['a', 'd', 'b', 'c']);
});

test('moveItem is a no-op copy for same index and clamps out of range', () => {
	const src = ['a', 'b'];
	const same = moveItem(src, 1, 1);
	assert.deepEqual(same, ['a', 'b']);
	assert.notEqual(same, src);
	assert.deepEqual(moveItem(src, 0, 9), ['b', 'a']);
	assert.deepEqual(moveItem([], 0, 1), []);
});
