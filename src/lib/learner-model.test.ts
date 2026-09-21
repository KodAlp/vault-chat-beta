import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	GUESS_RATE, HALF_LIFE_DAYS, HIGH_CONFIDENCE_WEIGHT, MIN_RELIABLE_CARDS, MIN_RELIABLE_WEIGHT, UNKNOWN_DOMAIN,
	bandOf, buildProfile, cardRetention, evidenceWeight, masteryOf, retentionOf,
	type CardPoint, type EvidencePoint
} from './learner-model';

const NOW = new Date('2026-09-21T12:00:00.000Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();
const point = (over: Partial<EvidencePoint> = {}): EvidencePoint => ({
	key: 'k' + Math.random(), sourcePath: 'wiki/math/calculus.md', domains: ['math'], type: 'open', correct: true, at: daysAgo(0), level: null, ...over
});
const near = (a: number | null, b: number, eps = 1e-9) => assert.ok(a !== null && Math.abs(a - b) < eps, `${a} vs ${b}`);

test('no evidence: mastery is null, not 0.5, and confidence says so', () => {
	const m = masteryOf([], NOW);
	assert.equal(m.mastery, null);
	assert.equal(m.count, 0);
	assert.equal(m.confidence, 'none');
	assert.equal(m.reliable, false);
	assert.equal(m.lastAt, null);
});

test('the weight of an answer: full for open, halved for true/false, four fifths for multiple choice', () => {
	near(evidenceWeight({ type: 'open', at: daysAgo(0) }, NOW), 1);
	near(evidenceWeight({ type: 'true_false', at: daysAgo(0) }, NOW), 0.5);
	near(evidenceWeight({ type: 'multiple_choice', at: daysAgo(0) }, NOW), 0.8);
	assert.deepEqual(GUESS_RATE, { true_false: 0.5, multiple_choice: 0.2, open: 0 });
});

test('an answer loses half its weight every 45 days, and one from the future does not weigh more than one from now', () => {
	near(evidenceWeight({ type: 'open', at: daysAgo(HALF_LIFE_DAYS) }, NOW), 0.5);
	near(evidenceWeight({ type: 'open', at: daysAgo(2 * HALF_LIFE_DAYS) }, NOW), 0.25);
	near(evidenceWeight({ type: 'open', at: daysAgo(-3) }, NOW), 1);
	near(evidenceWeight({ type: 'open', at: 'not a date' }, NOW), 1, 1e-9);
});

test('mastery = (sum(w*correct)+1)/(sum(w)+2): one right open answer is 2/3, not 100%', () => {
	near(masteryOf([point()], NOW).mastery, 2 / 3);
	near(masteryOf([point({ correct: false })], NOW).mastery, 1 / 3);
	// three right, one wrong, all open and fresh: (3+1)/(4+2)
	near(masteryOf([point(), point(), point(), point({ correct: false })], NOW).mastery, 4 / 6);
});

test('a right true/false answer moves the estimate half as far as a right open answer', () => {
	near(masteryOf([point({ type: 'true_false' })], NOW).mastery, 1.5 / 2.5);
	assert.ok(masteryOf([point({ type: 'true_false' })], NOW).mastery! < masteryOf([point()], NOW).mastery!);
});

test('old answers count less: a wrong answer from long ago is outvoted by a fresh right one', () => {
	const m = masteryOf([point({ correct: false, at: daysAgo(180) }), point()], NOW).mastery!;
	assert.ok(m > 0.5, String(m));
	const both = masteryOf([point({ correct: false }), point()], NOW).mastery!;
	near(both, 0.5);
});

test('confidence steps: none, insufficient below 3 units of evidence, moderate below 8, high from 8', () => {
	const many = (n: number) => Array.from({ length: n }, () => point());
	assert.equal(masteryOf(many(1), NOW).confidence, 'insufficient');
	assert.equal(masteryOf(many(2), NOW).reliable, false);
	assert.equal(masteryOf(many(MIN_RELIABLE_WEIGHT), NOW).confidence, 'moderate');
	assert.equal(masteryOf(many(MIN_RELIABLE_WEIGHT), NOW).reliable, true);
	assert.equal(masteryOf(many(HIGH_CONFIDENCE_WEIGHT - 1), NOW).confidence, 'moderate');
	assert.equal(masteryOf(many(HIGH_CONFIDENCE_WEIGHT), NOW).confidence, 'high');
	// evidence that is old or easy to guess adds up slowly: 6 true/false answers are only 3 units
	assert.equal(masteryOf(Array.from({ length: 6 }, () => point({ type: 'true_false' })), NOW).confidence, 'moderate');
	assert.equal(masteryOf(Array.from({ length: 5 }, () => point({ type: 'true_false' })), NOW).confidence, 'insufficient');
});

test('lastAt is the newest counted answer', () => {
	assert.equal(masteryOf([point({ at: daysAgo(9) }), point({ at: daysAgo(2) }), point({ at: daysAgo(5) })], NOW).lastAt, daysAgo(2));
});

const card = (over: Partial<CardPoint> = {}): CardPoint => ({ sourcePath: 'wiki/os/scheduling.md', domains: ['os'], intervalDays: 10, dueAt: daysAgo(-10), reps: 3, lapses: 0, ...over });

test('card retention is 0.9 on the due day, higher before it and 0.81 one interval later', () => {
	near(cardRetention(card({ dueAt: daysAgo(0) }), NOW), 0.9);
	assert.ok(cardRetention(card({ dueAt: daysAgo(-5) }), NOW)! > 0.9);
	near(cardRetention(card({ dueAt: daysAgo(10) }), NOW), 0.81);
	near(cardRetention(card({ dueAt: daysAgo(-10) }), NOW), 1); // reviewed just now
});

test('a card never reviewed has no retention; one whose last answer was "again" is forgotten', () => {
	assert.equal(cardRetention(card({ reps: 0, lapses: 0, intervalDays: 0 }), NOW), null);
	assert.equal(cardRetention(card({ reps: 4, lapses: 1, intervalDays: 0 }), NOW), 0);
	assert.equal(cardRetention(card({ reps: 0, lapses: 2, intervalDays: 0 }), NOW), 0);
	assert.equal(cardRetention(card({ dueAt: 'not a date' }), NOW), null);
});

test('node retention is the mean over reviewed cards and needs three of them to be called reliable', () => {
	const cards = [card({ dueAt: daysAgo(0) }), card({ dueAt: daysAgo(10) }), card({ reps: 0, lapses: 0, intervalDays: 0 })];
	const r = retentionOf(cards, NOW);
	assert.equal(r.cards, 2);
	near(r.retention, (0.9 + 0.81) / 2);
	assert.equal(r.reliable, false);
	assert.equal(retentionOf(Array.from({ length: MIN_RELIABLE_CARDS }, () => card()), NOW).reliable, true);
	assert.deepEqual(retentionOf([], NOW), { retention: null, cards: 0, reliable: false });
});

test('bands: recall/understanding are basic, application/higher are applied', () => {
	assert.equal(bandOf('recall'), 'basic');
	assert.equal(bandOf('understanding'), 'basic');
	assert.equal(bandOf('application'), 'applied');
	assert.equal(bandOf('higher'), 'applied');
});

test('the profile always has an overall node, and an empty history gives nothing else', () => {
	const p = buildProfile({ points: [], cards: [], now: NOW });
	assert.equal(p.nodes.length, 1);
	assert.equal(p.nodes[0].id, 'overall');
	assert.equal(p.nodes[0].quiz.mastery, null);
	assert.equal(p.nodes[0].bands, null);
	assert.equal(p.generatedAt, NOW.toISOString());
});

test('a note in two domains counts once overall and once in each of its domains', () => {
	const p = buildProfile({ points: [point({ domains: ['math', 'algorithms'], sourcePath: 'wiki/a.md' }), point({ domains: ['math'], sourcePath: 'wiki/b.md' })], cards: [], now: NOW });
	const by = (id: string) => p.nodes.find((n) => n.id === id)!;
	assert.equal(by('overall').quiz.count, 2);
	assert.equal(by('domain:math').quiz.count, 2);
	assert.equal(by('domain:algorithms').quiz.count, 1);
	assert.equal(by('note:wiki/a.md').quiz.count, 1);
	assert.deepEqual(by('note:wiki/a.md').domains, ['math', 'algorithms']);
	assert.equal(by('note:wiki/a.md').name, 'a');
});

test('a note the index does not know lands in the unknown domain instead of disappearing', () => {
	const p = buildProfile({ points: [point({ domains: [] })], cards: [], now: NOW });
	assert.equal(p.nodes.find((n) => n.id === `domain:${UNKNOWN_DOMAIN}`)?.quiz.count, 1);
});

test('domains are ordered by how much evidence they hold, so the meaningful numbers come first', () => {
	const pts = [...Array.from({ length: 3 }, () => point({ domains: ['os'], sourcePath: 'wiki/os.md' })), point({ domains: ['math'] })];
	const names = buildProfile({ points: pts, cards: [], now: NOW }).nodes.filter((n) => n.kind === 'domain').map((n) => n.name);
	assert.deepEqual(names, ['os', 'math']);
});

test('bands appear only when a counted question carries a level, and each band is estimated on its own', () => {
	const none = buildProfile({ points: [point(), point()], cards: [], now: NOW });
	assert.equal(none.nodes[0].bands, null);
	const some = buildProfile({ points: [point({ level: 'recall' }), point({ level: 'understanding' }), point({ level: 'application', correct: false }), point()], cards: [], now: NOW });
	const b = some.nodes[0].bands!;
	assert.equal(b.basic.count, 2);
	assert.equal(b.applied.count, 1);
	near(b.basic.mastery, 3 / 4);
	near(b.applied.mastery, 1 / 3);
	assert.equal(some.nodes[0].quiz.count, 4, 'the unlabelled question still counts overall');
});

test('cards and quiz answers stay separate numbers on the same node', () => {
	const p = buildProfile({ points: [point({ domains: ['os'], sourcePath: 'wiki/os/scheduling.md' })], cards: [card({ dueAt: daysAgo(0) })], now: NOW });
	const os = p.nodes.find((n) => n.id === 'domain:os')!;
	near(os.quiz.mastery, 2 / 3);
	near(os.retention.retention, 0.9);
});
