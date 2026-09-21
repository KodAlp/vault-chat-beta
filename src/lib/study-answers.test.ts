import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAnswered, scoreExcludingFlagged } from './study-answers';

test('an empty or whitespace-only answer is a skipped question', () => {
	for (const v of ['', ' ', '   ', '\n', '\t \n', null, undefined]) assert.equal(isAnswered(v), false, JSON.stringify(v));
});

test('any real content is an answer, including the ones that look like nothing', () => {
	for (const v of ['7', 'false', '0', 'x', ' a ', 'Periyodik fonksiyonlar', '$\\pi$']) assert.equal(isAnswered(v), true, JSON.stringify(v));
});

test('non-string values are never answers', () => {
	for (const v of [0, 1, {}, [], true] as unknown[]) assert.equal(isAnswered(v as string), false);
});

test('with nothing flagged the score is correct / total', () => {
	const r = scoreExcludingFlagged([{ isCorrect: true }, { isCorrect: false }, { isCorrect: true }, { isCorrect: false }]);
	assert.deepEqual(r, { score: 0.5, correct: 2, counted: 4, excluded: 0 });
});

test('a flagged question leaves both the numerator and the denominator', () => {
	// 1 of 3 correct; the wrong one that was flagged (a bad answer key) stops counting against the user
	const r = scoreExcludingFlagged([{ isCorrect: true }, { isCorrect: false }, { isCorrect: false, flagged: true }]);
	assert.equal(r.counted, 2);
	assert.equal(r.excluded, 1);
	assert.equal(r.score, 0.5);
	// a flagged question the user happened to get right does not count for them either
	assert.equal(scoreExcludingFlagged([{ isCorrect: true, flagged: true }, { isCorrect: false }]).score, 0);
});

test('everything flagged gives a zero score over zero counted questions, not NaN', () => {
	const r = scoreExcludingFlagged([{ isCorrect: false, flagged: true }, { isCorrect: true, flagged: true }]);
	assert.deepEqual(r, { score: 0, correct: 0, counted: 0, excluded: 2 });
	assert.deepEqual(scoreExcludingFlagged([]), { score: 0, correct: 0, counted: 0, excluded: 0 });
});
