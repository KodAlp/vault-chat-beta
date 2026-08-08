import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectHallucinationHedges } from './hallucination';

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
