import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LOCALES, DEFAULT_LOCALE, isLocale, localeInfo, intlLocale, migrateLocale, LEGACY_LOCALES } from './locales';

test('the 23 UI languages are listed in picker order, tr and en first', () => {
	assert.deepEqual(
		LOCALES.map((l) => l.code),
		['tr', 'en', 'zh-CN', 'hi', 'es', 'ar', 'fr', 'bn', 'pt', 'id', 'ur', 'ru', 'de', 'ja', 'ko', 'it', 'nl', 'pl', 'cs', 'sv', 'nb', 'da', 'fi']
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

test('only Arabic and Urdu are right-to-left', () => {
	assert.deepEqual(
		LOCALES.filter((l) => l.dir === 'rtl').map((l) => l.code),
		['ar', 'ur']
	);
});

test('no shipped locale has a parent', () => {
	assert.deepEqual(LOCALES.filter((l) => 'parent' in l).map((l) => l.code), []);
});

test('retired locales migrate to a shipped relative, never to the default by accident', () => {
	assert.equal(migrateLocale('pcm'), 'en');
	assert.equal(migrateLocale('ar-EG'), 'ar');
	for (const [old, next] of Object.entries(LEGACY_LOCALES)) {
		assert.equal(isLocale(old), false, `${old} must not be offered any more`);
		assert.equal(isLocale(next), true, `${old} -> ${next} must point at a shipped locale`);
	}
	for (const l of LOCALES) assert.equal(migrateLocale(l.code), l.code);
	for (const bad of ['xx', 'toString', '__proto__', '', null, undefined, 3]) assert.equal(migrateLocale(bad), undefined, String(bad));
});

test('localeInfo returns the entry, and the default locale for unknown codes', () => {
	assert.equal(localeInfo('ur').dir, 'rtl');
	assert.equal(localeInfo('fi').nativeName, 'Suomi');
	assert.equal(localeInfo('nope').code, DEFAULT_LOCALE);
});

test('intlLocale always yields a tag Intl accepts', () => {
	for (const l of LOCALES) {
		const tag = intlLocale(l.code);
		assert.doesNotThrow(() => new Intl.RelativeTimeFormat(tag), l.code);
	}
	assert.equal(intlLocale('not a tag!!'), 'en');
});
