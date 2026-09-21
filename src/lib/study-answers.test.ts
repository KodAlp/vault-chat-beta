import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAnswered } from './study-answers';

test('an empty or whitespace-only answer is a skipped question', () => {
	for (const v of ['', ' ', '   ', '\n', '\t \n', null, undefined]) assert.equal(isAnswered(v), false, JSON.stringify(v));
});

test('any real content is an answer, including the ones that look like nothing', () => {
	for (const v of ['7', 'false', '0', 'x', ' a ', 'Periyodik fonksiyonlar', '$\\pi$']) assert.equal(isAnswered(v), true, JSON.stringify(v));
});

test('non-string values are never answers', () => {
	for (const v of [0, 1, {}, [], true] as unknown[]) assert.equal(isAnswered(v as string), false);
});
