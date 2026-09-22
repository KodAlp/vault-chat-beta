import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWeakSpots, type CardErrorPoint } from './learner-errors';
import type { AnswerRow } from './learner-evidence';

const row = (over: Partial<AnswerRow> = {}): AnswerRow => ({
	itemId: 'i' + Math.random(), quizId: 'q1', answeredAt: '2026-09-10T10:00:00.000Z', given: 'B', isCorrect: false, type: 'multiple_choice',
	question: 'Hangisi doğrudur?', sourcePath: 'wiki/os/scheduling.md', headingPath: 'Scheduling', correctAnswer: 'A', modelFeedback: null,
	flaggedAt: null, cognitiveLevel: null, options: ['A', 'B', 'C', 'D'], ...over
});

const card = (over: Partial<CardErrorPoint> = {}): CardErrorPoint => ({
	id: 'c' + Math.random(), front: 'f', back: 'b', sourcePath: 'wiki/os/scheduling.md', headingPath: 'Scheduling',
	domains: ['os'], intervalDays: 0, lapses: 1, dueAt: '2026-09-10T10:00:00.000Z', ...over
});

const domains = (p: string) => (p.startsWith('wiki/os') ? ['os'] : []);
const build = (answers: AnswerRow[] = [], cards: CardErrorPoint[] = []) => buildWeakSpots({ answers, cards, domainsOf: domains });

test('a question always answered right is not a weak spot', () => {
	assert.equal(build([row({ isCorrect: true })]).length, 0);
});

test('a wrong-and-never-retried question is an open error with what was chosen and what was right', () => {
	const [spot] = build([row({ given: 'B', correctAnswer: 'A' })]);
	assert.equal(spot.openErrors, 1);
	assert.equal(spot.resolvedErrors, 0);
	assert.deepEqual(spot.errors[0].confusion, { chose: 'B', correct: 'A' });
	assert.equal(spot.errors[0].resolved, false);
	assert.equal(spot.errors[0].wrongCount, 1);
});

test('the same question wrong then right is resolved, not open, and confusion is cleared', () => {
	const wrong = row({ itemId: 'a', answeredAt: '2026-09-01T00:00:00.000Z', isCorrect: false });
	const right = row({ itemId: 'a', answeredAt: '2026-09-05T00:00:00.000Z', isCorrect: true });
	const [spot] = build([right, wrong]); // input order must not matter
	assert.equal(spot.openErrors, 0);
	assert.equal(spot.resolvedErrors, 1);
	assert.equal(spot.errors[0].resolved, true);
	assert.equal(spot.errors[0].confusion, null);
	assert.equal(spot.errors[0].wrongCount, 1, 'one of the two attempts was wrong');
});

test('a historical duplicate (retaken quiz, new item id) is one weak spot, not two', () => {
	const first = row({ itemId: 'a', quizId: 'q1', answeredAt: '2026-09-01T00:00:00.000Z', isCorrect: false });
	const twin = row({ itemId: 'b', quizId: 'q2', answeredAt: '2026-09-08T00:00:00.000Z', isCorrect: false, question: '  hangisi DOĞRUDUR? ' });
	const [spot] = build([first, twin]);
	assert.equal(spot.errors.length, 1);
	assert.equal(spot.errors[0].wrongCount, 2);
	assert.equal(spot.errors[0].quizId, 'q2', 'the latest attempt\'s quiz id is used (for the flag route)');
});

test('a blank, flagged, or options-less multiple-choice answer is never a weak spot (same rule as F1b)', () => {
	assert.equal(build([row({ given: '' })]).length, 0);
	assert.equal(build([row({ flaggedAt: '2026-09-11T00:00:00.000Z' })]).length, 0);
	assert.equal(build([row({ options: null })]).length, 0);
});

test('an open question carries the model feedback only while unresolved', () => {
	const open = row({ type: 'open', given: 'yanlış cevap', correctAnswer: 'doğru cevap', modelFeedback: 'eksik', isCorrect: false });
	assert.equal(build([open])[0].errors[0].modelFeedback, 'eksik');

	const wasWrong = row({ itemId: 'a', type: 'open', answeredAt: '2026-09-01T00:00:00.000Z', isCorrect: false, modelFeedback: 'eksik' });
	const nowRight = row({ itemId: 'a', type: 'open', answeredAt: '2026-09-05T00:00:00.000Z', isCorrect: true, modelFeedback: 'tam' });
	assert.equal(build([wasWrong, nowRight])[0].errors[0].modelFeedback, undefined, 'resolved: no need for feedback on a fixed answer');
});

test('a leftover letter label on an older row is stripped from the confusion text', () => {
	const [spot] = build([row({ given: 'B) yanlış', correctAnswer: 'A) doğru' })]);
	assert.deepEqual(spot.errors[0].confusion, { chose: 'yanlış', correct: 'doğru' });
});

test('a card recovering (interval restarted) counts as lapsed but not forgotten, and is resolved', () => {
	const [spot] = build([], [card({ intervalDays: 3, lapses: 2 })]);
	assert.equal(spot.lapsedCards, 1);
	assert.equal(spot.forgottenCards, 0);
	assert.equal(spot.errors[0].resolved, true);
	assert.equal(spot.errors[0].wrongCount, 2);
});

test('a card at interval 0 is currently forgotten, not resolved', () => {
	const [spot] = build([], [card({ intervalDays: 0 })]);
	assert.equal(spot.forgottenCards, 1);
	assert.equal(spot.errors[0].resolved, false);
});

test('a quiz error and a lapsed card on the same note and heading share one weak spot', () => {
	const [spot] = build([row({ sourcePath: 'wiki/os/scheduling.md', headingPath: 'Scheduling' })], [card({ sourcePath: 'wiki/os/scheduling.md', headingPath: 'Scheduling' })]);
	assert.equal(spot.errors.length, 2);
	assert.ok(spot.errors.some((e) => e.kind === 'quiz'));
	assert.ok(spot.errors.some((e) => e.kind === 'card'));
});

test('a different heading in the same note is a different weak spot', () => {
	const spots = build([row({ headingPath: 'A', question: 'soru A' }), row({ headingPath: 'B', question: 'soru B' })]);
	assert.equal(spots.length, 2);
});

test('domains, note name and id come from the source path', () => {
	const [spot] = build([row({ sourcePath: 'wiki/os/scheduling.md', headingPath: 'Scheduling' })]);
	assert.equal(spot.sourcePath, 'wiki/os/scheduling.md');
	assert.equal(spot.noteName, 'scheduling');
	assert.deepEqual(spot.domains, ['os']);
	assert.equal(spot.id, 'wiki/os/scheduling.md::Scheduling');
});

test('weak spots sort by open-error count, most first; a card weak spot with no open quiz errors sorts after', () => {
	const busy = row({ sourcePath: 'wiki/os/a.md', headingPath: 'A', question: 'q1' });
	const quiet = row({ sourcePath: 'wiki/os/b.md', headingPath: 'B', question: 'q2', answeredAt: '2026-09-01T00:00:00.000Z' });
	const quietFixed = row({ itemId: 'x', sourcePath: 'wiki/os/b.md', headingPath: 'B', question: 'q2', isCorrect: true, answeredAt: '2026-09-05T00:00:00.000Z' });
	const spots = build([busy, quiet, quietFixed]);
	assert.equal(spots[0].sourcePath, 'wiki/os/a.md', 'the still-open one sorts first');
	assert.equal(spots[1].sourcePath, 'wiki/os/b.md');
});

test('inside a weak spot, unresolved errors sort before resolved ones', () => {
	const open = row({ itemId: 'a', question: 'open one', isCorrect: false });
	const resolvedWrong = row({ itemId: 'b', question: 'resolved one', answeredAt: '2026-09-01T00:00:00.000Z', isCorrect: false });
	const resolvedRight = row({ itemId: 'b', question: 'resolved one', answeredAt: '2026-09-05T00:00:00.000Z', isCorrect: true });
	const [spot] = build([resolvedRight, resolvedWrong, open]);
	assert.equal(spot.errors[0].resolved, false);
	assert.equal(spot.errors[1].resolved, true);
});
