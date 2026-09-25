import { test } from 'node:test';
import assert from 'node:assert/strict';
import { relDirToSegments, MAX_BATCH_SUBDIR_DEPTH } from './batch-paths';

test('folds each segment, keeps the tree', () => {
	assert.deepEqual(relDirToSegments('kaynaklar/0_Kalkulus1'), ['kaynaklar', '0-kalkulus1']);
	assert.deepEqual(relDirToSegments('Doğrusal Cebir/Işık'), ['dogrusal-cebir', 'isik']);
});

test('empty input means no subdirectory', () => {
	assert.deepEqual(relDirToSegments(''), []);
});

test('Windows separators are split too', () => {
	assert.deepEqual(relDirToSegments('a\\b/c'), ['a', 'b', 'c']);
});

test('traversal segments are dropped, never resolved', () => {
	assert.deepEqual(relDirToSegments('../../etc'), ['etc']);
	assert.deepEqual(relDirToSegments('a/./../b'), ['a', 'b']);
	assert.deepEqual(relDirToSegments('/abs/path'), ['abs', 'path']);
	assert.deepEqual(relDirToSegments('C:\\Windows'), ['c', 'windows']);
});

test('segments that fold to nothing are dropped', () => {
	assert.deepEqual(relDirToSegments('!!!/a'), ['a']);
});

test('indexer-excluded names get a suffix so the notes stay indexable', () => {
	assert.deepEqual(relDirToSegments('raw/Attachments/templates'), [
		'raw-klasoru',
		'attachments-klasoru',
		'templates-klasoru'
	]);
});

test('depth is capped', () => {
	const deep = Array.from({ length: 10 }, (_, i) => `d${i}`).join('/');
	assert.equal(relDirToSegments(deep).length, MAX_BATCH_SUBDIR_DEPTH);
});
