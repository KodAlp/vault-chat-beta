import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_PHRASE_CHARS, shouldOfferNotRelevant } from './smalltalk-limits';

test('confident source among weak fillers (small vault): no button', () => {
	assert.equal(shouldOfferNotRelevant([{ distance: 0.31 }, { distance: 0.58 }, { distance: 0.59 }], 20), false);
});

test('only weak vector sources for a short message: button offered', () => {
	assert.equal(shouldOfferNotRelevant([{ distance: 0.55 }, { distance: 0.58 }], 5), true);
});

test('keyword-only sources are never confident: button offered', () => {
	assert.equal(shouldOfferNotRelevant([{ distance: 1, via: 'keyword' }], 12), true);
});

test('keyword placeholder distance does not hide nor fake confidence', () => {
	assert.equal(shouldOfferNotRelevant([{ distance: 0, via: 'keyword' }], 12), true);
});

test('no sources or long/empty question: no button', () => {
	assert.equal(shouldOfferNotRelevant([], 5), false);
	assert.equal(shouldOfferNotRelevant(undefined, 5), false);
	assert.equal(shouldOfferNotRelevant([{ distance: 0.58 }], MAX_PHRASE_CHARS + 1), false);
	assert.equal(shouldOfferNotRelevant([{ distance: 0.58 }], 0), false);
});
