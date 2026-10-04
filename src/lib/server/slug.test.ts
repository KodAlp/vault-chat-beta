import { test } from 'node:test';
import assert from 'node:assert/strict';
import { foldToSlug, capSlug, MAX_SLUG_LENGTH } from './slug';

// K4 (2026-09-23 report): Turkish dotless ı (U+0131) has no canonical
// Unicode decomposition, unlike ç/ğ/ö/ş/ü — NFKD leaves it untouched, and the
// ascii-only replace at the end of foldToSlug then turns it into a bare
// hyphen. "Kapalı" folded to "kapal" (the trailing ı silently vanished as a
// hyphen the trim then ate); a mid-word ı ("Çığlık") produced "c-gl-k".

test('dotless ı folds to i, not a dropped hyphen', () => {
	assert.equal(foldToSlug('Kapalı'), 'kapali');
	assert.equal(foldToSlug('ıspanak'), 'ispanak');
});

test('a mid-word ı no longer breaks the surrounding letters into fragments', () => {
	assert.equal(foldToSlug('Çığlık'), 'ciglik');
	assert.equal(foldToSlug('Ğırla'), 'girla');
});

test('the other Turkish letters (ç ğ ö ş ü İ) still fold correctly — not a regression', () => {
	assert.equal(foldToSlug('Öğün'), 'ogun');
	assert.equal(foldToSlug('Şeker'), 'seker');
	assert.equal(foldToSlug('Üzüm'), 'uzum');
	assert.equal(foldToSlug('İstanbul'), 'istanbul');
});

test('plain ascii input is unaffected', () => {
	assert.equal(foldToSlug('Linear Algebra'), 'linear-algebra');
});

test('empty or all-punctuation input falls back', () => {
	assert.equal(foldToSlug(''), 'adsiz');
	assert.equal(foldToSlug('!!!'), 'adsiz');
	assert.equal(foldToSlug('', 'ozel-varsayilan'), 'ozel-varsayilan');
});

test('capSlug cuts to the limit and trims a trailing hyphen', () => {
	assert.equal(capSlug('abc', 10), 'abc');
	assert.equal(capSlug('abcd-efgh', 5), 'abcd');
	assert.equal(capSlug('a'.repeat(300)).length, MAX_SLUG_LENGTH);
});
