import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickEvidence, type AnswerRow } from './learner-evidence';

const row = (over: Partial<AnswerRow> = {}): AnswerRow => ({
	itemId: 'i' + Math.random(), answeredAt: '2026-09-10T10:00:00.000Z', given: 'B', isCorrect: true, type: 'multiple_choice',
	question: 'Hangisi doğrudur?', sourcePath: 'wiki/os/scheduling.md', flaggedAt: null, cognitiveLevel: null,
	options: ['A', 'B', 'C', 'D'], ...over
});
const domains = (p: string) => (p.startsWith('wiki/os') ? ['os'] : []);

test('a blank answer is never evidence, even when the grader stored it as correct', () => {
	for (const given of ['', '   ', '\n']) assert.equal(pickEvidence([row({ given, isCorrect: true })], domains).length, 0, JSON.stringify(given));
	assert.equal(pickEvidence([row({ given: '0', isCorrect: false })], domains).length, 1, 'a real answer that looks like nothing is still an answer');
});

test('a flagged question is not evidence, right or wrong', () => {
	assert.equal(pickEvidence([row({ flaggedAt: '2026-09-11T00:00:00.000Z', isCorrect: false })], domains).length, 0);
	assert.equal(pickEvidence([row({ flaggedAt: '2026-09-11T00:00:00.000Z', isCorrect: true })], domains).length, 0);
});

test('the same question stored twice (a historical duplicate) is one piece of evidence', () => {
	const a = row({ itemId: 'a', question: 'Süreç grubu nedir?' });
	const b = row({ itemId: 'b', question: '  süreç GRUBU nedir? ' });
	assert.equal(pickEvidence([a, b], domains).length, 1);
});

test('the same words from another source part are another question', () => {
	assert.equal(pickEvidence([row({ sourcePath: 'wiki/os/a.md' }), row({ sourcePath: 'wiki/os/b.md' })], domains).length, 2);
});

test('template questions with different numbers stay separate (the key keeps digits)', () => {
	assert.equal(pickEvidence([row({ question: "f'(x) at x=1 of 1/x^2" }), row({ question: "f'(x) at x=3 of 1/x^3" })], domains).length, 2);
});

test('retaking a quiz is not five pieces of evidence: the latest answered attempt counts', () => {
	const first = row({ itemId: 'q', answeredAt: '2026-09-01T10:00:00.000Z', isCorrect: false });
	const second = row({ itemId: 'q', answeredAt: '2026-09-08T10:00:00.000Z', isCorrect: true });
	const third = row({ itemId: 'q', answeredAt: '2026-09-15T10:00:00.000Z', isCorrect: false });
	const out = pickEvidence([second, first, third], domains); // input order must not matter
	assert.equal(out.length, 1);
	assert.equal(out[0].correct, false);
	assert.equal(out[0].at, '2026-09-15T10:00:00.000Z');
});

test('a later blank answer does not replace an earlier real one', () => {
	const real = row({ itemId: 'q', answeredAt: '2026-09-01T10:00:00.000Z', isCorrect: true });
	const blank = row({ itemId: 'q', answeredAt: '2026-09-09T10:00:00.000Z', given: '', isCorrect: false });
	const out = pickEvidence([real, blank], domains);
	assert.equal(out.length, 1);
	assert.equal(out[0].correct, true);
});

test('a flagged twin does not hide the unflagged copy of the same question', () => {
	const flagged = row({ itemId: 'x', flaggedAt: '2026-09-11T00:00:00.000Z', isCorrect: false });
	const fine = row({ itemId: 'y', isCorrect: true });
	const out = pickEvidence([flagged, fine], domains);
	assert.equal(out.length, 1);
	assert.equal(out[0].correct, true);
});

test('identical timestamps: the row that came later wins', () => {
	const a = row({ itemId: 'q', isCorrect: false });
	const b = row({ itemId: 'q', isCorrect: true });
	assert.equal(pickEvidence([a, b], domains)[0].correct, true);
});

test('the point carries the note, its domains, the type and the level (only a real level)', () => {
	const [p] = pickEvidence([row({ type: 'open', cognitiveLevel: 'application' })], domains);
	assert.equal(p.sourcePath, 'wiki/os/scheduling.md');
	assert.deepEqual(p.domains, ['os']);
	assert.equal(p.type, 'open');
	assert.equal(p.level, 'application');
	assert.equal(pickEvidence([row({ cognitiveLevel: 'analysis' })], domains)[0].level, null, 'the six-level names are not levels any more');
	assert.equal(pickEvidence([row({ cognitiveLevel: null })], domains)[0].level, null);
});

test('an unknown question type is skipped rather than guessed', () => {
	assert.equal(pickEvidence([row({ type: 'essay' })], domains).length, 0);
});

test('a multiple-choice question stored without options is not evidence', () => {
	assert.equal(pickEvidence([row({ options: null })], domains).length, 0);
	assert.equal(pickEvidence([row({ options: [] })], domains).length, 0);
	assert.equal(pickEvidence([row({ options: ['A', 'B'] })], domains).length, 1);
});

test('a true/false or open question needs no options to be evidence', () => {
	assert.equal(pickEvidence([row({ type: 'true_false', options: null })], domains).length, 1);
	assert.equal(pickEvidence([row({ type: 'open', options: null })], domains).length, 1);
});
