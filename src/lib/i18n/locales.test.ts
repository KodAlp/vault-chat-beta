import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LOCALES, DEFAULT_LOCALE, isLocale, localeInfo, intlLocale } from './locales';

test('the 16 UI languages are listed in picker order, tr and en first', () => {
	assert.deepEqual(
		LOCALES.map((l) => l.code),
		['tr', 'en', 'zh-CN', 'hi', 'es', 'ar', 'fr', 'bn', 'pt', 'id', 'ur', 'ru', 'de', 'ja', 'pcm', 'ar-EG']
	);
});

test('codes are unique and every entry has both names', () => {
	assert.equal(new Set(LOCALES.map((l) => l.code)).size, LOCALES.length);
	for (const l of LOCALES) {
		assert.ok(l.nativeName.length > 0 && l.englishName.length > 0, l.code);
	}
});

test('isLocale accepts exact codes only', () => {
	for (const l of LOCALES) assert.equal(isLocale(l.code), true, l.code);
	for (const bad of ['xx', 'ar-eg', 'zh', 'EN', '', null, undefined, 3, {}]) assert.equal(isLocale(bad), false, String(bad));
});

test('only Arabic, Urdu and Egyptian Arabic are right-to-left', () => {
	assert.deepEqual(
		LOCALES.filter((l) => l.dir === 'rtl').map((l) => l.code),
		['ar', 'ur', 'ar-EG']
	);
});

test('parents: ar-EG -> ar, pcm -> en, nothing else has one, and every parent is itself a locale', () => {
	const withParent = LOCALES.filter((l) => 'parent' in l).map((l) => [l.code, (l as { parent: string }).parent]);
	assert.deepEqual(withParent, [
		['pcm', 'en'],
		['ar-EG', 'ar']
	]);
	for (const [, parent] of withParent) assert.equal(isLocale(parent), true);
});

test('localeInfo returns the entry, and the default locale for unknown codes', () => {
	assert.equal(localeInfo('ur').dir, 'rtl');
	assert.equal(localeInfo('ar-EG').parent, 'ar');
	assert.equal(localeInfo('nope').code, DEFAULT_LOCALE);
});

test('intlLocale always yields a tag Intl accepts', () => {
	for (const l of LOCALES) {
		const tag = intlLocale(l.code);
		assert.doesNotThrow(() => new Intl.RelativeTimeFormat(tag), l.code);
	}
	assert.equal(intlLocale('not a tag!!'), 'en');
});
