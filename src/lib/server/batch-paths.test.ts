import { test } from 'node:test';
import assert from 'node:assert/strict';
import { relDirToSegments, MAX_BATCH_SUBDIR_DEPTH, MAX_BATCH_SEGMENT_LENGTH } from './batch-paths';

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

// Every segment must be a plain ascii slug: never '.', '..', empty, absolute,
// or carrying a drive letter / separator / NUL / control character.
function assertSafe(segments: string[]): void {
	assert.ok(segments.length <= MAX_BATCH_SUBDIR_DEPTH);
	for (const seg of segments) {
		assert.match(seg, /^[a-z0-9]+(-[a-z0-9]+)*$/, `unsafe segment: ${JSON.stringify(seg)}`);
		assert.ok(seg.length <= MAX_BATCH_SEGMENT_LENGTH);
	}
}

test('hostile relDir inputs never yield an unsafe segment', () => {
	const inputs = [
		'../x',
		'..\\x',
		'/abs/x',
		'C:\\x',
		'C:/x',
		'a/../../b',
		'a\\..\\..\\b',
		'./a/./b',
		'//server/share/x',
		'\\\\server\\share',
		' / /a/ /',
		'\t/a',
		'a\0b/c',
		'\0',
		'..%2f..%2fetc',
		'....//x',
		'a/b/c/d/e/f/g/h/i',
		'con/nul/aux/prn/com1/lpt1',
		'x'.repeat(5000),
		'\u202e/\u200b/a'
	];
	for (const input of inputs) assertSafe(relDirToSegments(input));
});

test('specific hostile outputs', () => {
	assert.deepEqual(relDirToSegments('../x'), ['x']);
	assert.deepEqual(relDirToSegments('..\\x'), ['x']);
	assert.deepEqual(relDirToSegments('C:/x'), ['c', 'x']);
	assert.deepEqual(relDirToSegments('a/../../b'), ['a', 'b']);
	assert.deepEqual(relDirToSegments('a\\..\\..\\b'), ['a', 'b']);
	assert.deepEqual(relDirToSegments('./a/./b'), ['a', 'b']);
	assert.deepEqual(relDirToSegments(' / /a/ /'), ['a']);
	assert.deepEqual(relDirToSegments('a\0b/c'), ['a-b', 'c']);
	assert.deepEqual(relDirToSegments('\0'), []);
});

test('seven or more levels are capped at the first MAX levels', () => {
	const out = relDirToSegments('l1/l2/l3/l4/l5/l6/l7/l8');
	assert.deepEqual(out, ['l1', 'l2', 'l3', 'l4', 'l5', 'l6']);
});

test('very long segment names are truncated', () => {
	const out = relDirToSegments('a'.repeat(5000));
	assert.equal(out.length, 1);
	assert.equal(out[0].length, MAX_BATCH_SEGMENT_LENGTH);
});

test('reserved Windows device names get a suffix', () => {
	assert.deepEqual(relDirToSegments('CON/nul/Aux/prn/COM1/lpt9'), [
		'con-klasoru',
		'nul-klasoru',
		'aux-klasoru',
		'prn-klasoru',
		'com1-klasoru',
		'lpt9-klasoru'
	]);
});
