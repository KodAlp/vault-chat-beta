import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectHallucinationHedges, mergeHedgeMatches, MAX_HEDGE_MATCHES } from './hallucination';

test('detectHallucinationHedges returns [] for confident text with no hedges', () => {
	const thinking =
		'Kullanıcı 1 den 10 a kadar sayıları istiyor. Bunları Türkçe yazacağım: bir, iki, üç...';
	assert.deepEqual(detectHallucinationHedges(thinking), []);
});

test('detectHallucinationHedges returns [] for empty input', () => {
	assert.deepEqual(detectHallucinationHedges(''), []);
});

test('detectHallucinationHedges matches a Turkish hedge phrase', () => {
	const thinking = 'Bu konuda emin değilim, kaynaklarda net bir bilgi göremiyorum.';
	assert.deepEqual(detectHallucinationHedges(thinking), ['emin değilim']);
});

test('detectHallucinationHedges matches multiple distinct phrases without duplicates', () => {
	const thinking =
		"I'm not sure about this, and honestly I am not sure why either. The source doesn't mention it directly.";
	const result = detectHallucinationHedges(thinking);
	assert.deepEqual(result, ["i'm not sure", 'i am not sure', "doesn't mention"]);
});

test('detectHallucinationHedges caps at 6 matches', () => {
	const thinking = [
		'emin değilim',
		'sanırım',
		'galiba',
		'bilmiyorum',
		'hatırlamıyorum',
		'kesin değilim',
		'uydurmayayım'
	].join('. ');
	assert.equal(detectHallucinationHedges(thinking).length, 6);
});

test('detectHallucinationHedges is case-insensitive', () => {
	assert.deepEqual(detectHallucinationHedges('I AM NOT SURE about this.'), ['i am not sure']);
});

test('detectHallucinationHedges does not fire on unrelated common words', () => {
	const thinking = 'Bu doğru olabilir, çünkü kaynakta açıkça yazıyor. Cevap kesin: 42.';
	assert.deepEqual(detectHallucinationHedges(thinking), []);
});

test('mergeHedgeMatches unions two lists and drops duplicates', () => {
	assert.deepEqual(mergeHedgeMatches(['sanırım', 'galiba'], ['galiba', 'bilmiyorum']), ['sanırım', 'galiba', 'bilmiyorum']);
});

test('mergeHedgeMatches with one empty list returns the other unchanged', () => {
	assert.deepEqual(mergeHedgeMatches([], ['sanırım']), ['sanırım']);
	assert.deepEqual(mergeHedgeMatches(['sanırım'], []), ['sanırım']);
	assert.deepEqual(mergeHedgeMatches([], []), []);
});

test('mergeHedgeMatches re-caps at MAX_HEDGE_MATCHES when both lists are already full', () => {
	const a = Array.from({ length: MAX_HEDGE_MATCHES }, (_, i) => `a${i}`);
	const b = Array.from({ length: MAX_HEDGE_MATCHES }, (_, i) => `b${i}`);
	const merged = mergeHedgeMatches(a, b);
	assert.equal(merged.length, MAX_HEDGE_MATCHES);
	assert.deepEqual(merged, a);
});

test('mergeHedgeMatches keeps the reasoning-trace matches first, then fills from the answer', () => {
	const merged = mergeHedgeMatches(['x'], ['y', 'z']);
	assert.deepEqual(merged, ['x', 'y', 'z']);
});
