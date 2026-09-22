import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveMemorySignals } from './memory-runtime';
import type { LearnerProfile, MasteryEstimate, SkillNode } from '../learner-model';
import type { WeakSpot } from './learner-errors';

const mastery = (over: Partial<MasteryEstimate> = {}): MasteryEstimate => ({
	mastery: 0.5, count: 5, weight: 4, confidence: 'moderate', reliable: true, lastAt: null, ...over
});

const domainNode = (name: string, over: Partial<SkillNode> = {}): SkillNode => ({
	id: `domain:${name}`, kind: 'domain', name, quiz: mastery(), bands: null, retention: { retention: null, cards: 0, reliable: false }, ...over
});

const profile = (nodes: SkillNode[]): LearnerProfile => ({ generatedAt: new Date().toISOString(), nodes });

const spot = (over: Partial<WeakSpot> = {}): WeakSpot => ({
	id: 's', sourcePath: 'a.md', headingPath: 'H', noteName: 'a', domains: [], openErrors: 1, resolvedErrors: 0,
	lapsedCards: 0, forgottenCards: 0, lastSeen: new Date().toISOString(), errors: [], ...over
});

test('a reliable domain below the threshold is included, with mastery as a percent', () => {
	const { weakDomains } = deriveMemorySignals(profile([domainNode('databases', { quiz: mastery({ mastery: 0.42 }) })]), []);
	assert.deepEqual(weakDomains, [{ name: 'databases', masteryPct: 42 }]);
});

test('a domain at or above the threshold, or not reliable, or with no mastery, is excluded', () => {
	const nodes = [
		domainNode('strong', { quiz: mastery({ mastery: 0.8 }) }),
		domainNode('unreliable', { quiz: mastery({ mastery: 0.1, reliable: false }) }),
		domainNode('none', { quiz: mastery({ mastery: null }) })
	];
	assert.deepEqual(deriveMemorySignals(profile(nodes), []).weakDomains, []);
});

test('only domain-kind nodes are considered, not overall or note nodes', () => {
	const overall: SkillNode = { id: 'overall', kind: 'overall', name: 'overall', quiz: mastery({ mastery: 0.1 }), bands: null, retention: { retention: null, cards: 0, reliable: false } };
	const note: SkillNode = { id: 'note:x', kind: 'note', name: 'x', sourcePath: 'x.md', quiz: mastery({ mastery: 0.1 }), bands: null, retention: { retention: null, cards: 0, reliable: false } };
	assert.deepEqual(deriveMemorySignals(profile([overall, note]), []).weakDomains, []);
});

test('weak domains are sorted weakest first and capped at 3', () => {
	const nodes = ['a', 'b', 'c', 'd'].map((name, i) => domainNode(name, { quiz: mastery({ mastery: 0.1 * (i + 1) }) }));
	const { weakDomains } = deriveMemorySignals(profile(nodes), []);
	assert.equal(weakDomains.length, 3);
	assert.deepEqual(weakDomains.map((d) => d.name), ['a', 'b', 'c']);
});

test('a weak spot with open errors is included; one with only resolved errors or only cards is not', () => {
	const open = spot({ noteName: 'open-one', openErrors: 2 });
	const resolvedOnly = spot({ noteName: 'resolved-one', openErrors: 0, resolvedErrors: 3 });
	const cardsOnly = spot({ noteName: 'cards-one', openErrors: 0, forgottenCards: 1 });
	const { openWeakSpots } = deriveMemorySignals(profile([]), [open, resolvedOnly, cardsOnly]);
	assert.deepEqual(openWeakSpots, [{ noteName: 'open-one', openErrors: 2 }]);
});

test('open weak spots are capped at 3, in the order given (buildWeakSpots already sorts by open-error count)', () => {
	const spots = ['a', 'b', 'c', 'd'].map((n) => spot({ noteName: n, openErrors: 1 }));
	const { openWeakSpots } = deriveMemorySignals(profile([]), spots);
	assert.deepEqual(openWeakSpots.map((s) => s.noteName), ['a', 'b', 'c']);
});

test('nothing weak: both lists come back empty', () => {
	assert.deepEqual(deriveMemorySignals(profile([]), []), { weakDomains: [], openWeakSpots: [] });
});
