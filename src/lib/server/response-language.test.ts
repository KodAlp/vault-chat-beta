import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideResponseLanguage, resolveLanguageName, responseLanguageDirective } from './response-language';

/**
 * Regression test for the function lifted from scripts/eval-response-language.ts's V4 strategy
 * (measured 90/90 on a 30-case battery against qwen3:8b vs. ~57% for the old fixed-Turkish
 * behavior — see that script's doc comment). These are the exact examples requested when this
 * function was carried into product code (prompt.ts's buildPromptMessages).
 */

test('Turkish slang, no prior turns: reliable/narrowed detection names Turkish', () => {
	const d = decideResponseLanguage('abi b-tree nasıl çalışıyo ya', [], 'Türkçe');
	assert.equal(d.iso3, 'tur');
	assert.equal(d.englishName, 'Turkish');
	assert.notEqual(d.tier, 'fallback');
});

test('short Turkish follow-up after an English prior turn: narrowed candidate set still resolves to Turkish', () => {
	const d = decideResponseLanguage('peki silme işlemini nasıl yönetiyor?', ['What is a B-tree?'], 'Türkçe');
	assert.equal(d.iso3, 'tur');
	assert.equal(d.englishName, 'Turkish');
});

test('English slang: reliable/narrowed detection names English', () => {
	const d = decideResponseLanguage('yo how does a b-tree even work lol', [], 'Türkçe');
	assert.equal(d.iso3, 'eng');
	assert.equal(d.englishName, 'English');
});

test('a bare "why?" is too short to read a language off of: falls back to the primary language', () => {
	const d = decideResponseLanguage('why?', [], 'Türkçe');
	assert.equal(d.tier, 'fallback');
	assert.equal(d.iso3, 'tur');
	assert.equal(d.englishName, 'Turkish');
});

test('a bare "ok" is too short to read a language off of: falls back to the primary language', () => {
	const d = decideResponseLanguage('ok', [], 'Türkçe');
	assert.equal(d.tier, 'fallback');
	assert.equal(d.englishName, 'Turkish');
});

test('a clear German sentence is reliably detected on the full language set', () => {
	const d = decideResponseLanguage('Wie bleibt ein B-Baum ausgeglichen, wenn man viele neue Schlüssel einfügt?', [], 'Türkçe');
	assert.equal(d.iso3, 'deu');
	assert.equal(d.englishName, 'German');
	assert.equal(d.tier, 'reliable');
});

test('a code-only message carries no language signal: falls back to the primary language', () => {
	const d = decideResponseLanguage('```rust\nlet x = Box::new(5);\nlet y = x;\nprintln!("{}", x);\n```', [], 'Türkçe');
	assert.equal(d.tier, 'fallback');
	assert.equal(d.englishName, 'Turkish');
});

test('a formula-only message carries no language signal: falls back to the primary language', () => {
	const d = decideResponseLanguage('$$O(\\log n)$$', [], 'Türkçe');
	assert.equal(d.tier, 'fallback');
	assert.equal(d.englishName, 'Turkish');
});

test('responseLanguageDirective formats the decision as the exact line appended to the prompt', () => {
	const d = decideResponseLanguage('yo how does a b-tree even work lol', [], 'Türkçe');
	assert.equal(responseLanguageDirective(d), '(Answer in English.)');
});

test('resolveLanguageName maps language names as users type them, in any case or diacritic form', () => {
	// franc(name) on these single words used to return uzn/swh/qug/nld/por — see resolveLanguageName.
	const cases: [string, string][] = [
		['Türkçe', 'tur'],
		['turkce', 'tur'],
		['Turkish', 'tur'],
		['English', 'eng'],
		['İngilizce', 'eng'],
		['Deutsch', 'deu'],
		['Almanca', 'deu'],
		['German', 'deu'],
		['Korece', 'kor'],
		['한국어', 'kor'],
		['Español', 'spa'],
		['Français', 'fra']
	];
	for (const [name, iso3] of cases) assert.equal(resolveLanguageName(name), iso3, name);
	assert.equal(resolveLanguageName('Klingonca'), undefined);
});

test('a short Turkish -asyon question misread as Cebuano names no language on a first message', () => {
	for (const q of ['İzolasyon nasıl sağlanıyor?', 'izolasyon nasıl sağlanıyor?', 'Senkronizasyon nasıl yapılıyor?']) {
		const d = decideResponseLanguage(q, [], 'Türkçe');
		assert.equal(d.tier, 'generic', q);
		assert.equal(responseLanguageDirective(d), '(Answer in the same language as this message.)');
	}
});

test('the same short question after earlier turns still names no language (tier 2 would pick English)', () => {
	const d = decideResponseLanguage('İzolasyon nasıl sağlanıyor?', ['Bir B-ağacına çok fazla yeni anahtar eklendiğinde denge nasıl korunuyor?'], 'Türkçe');
	assert.equal(d.tier, 'generic');
});

test('a short message in a language already reliably used earlier is still named', () => {
	const d = decideResponseLanguage('Wie funktioniert ein Mutex genau?', ['Wie bleibt ein B-Baum ausgeglichen, wenn man viele neue Schlüssel einfügt?'], 'Türkçe');
	assert.notEqual(d.tier, 'generic');
});

test('an English primary language falls back to English, not to a misdetected one', () => {
	const d = decideResponseLanguage('why?', [], 'English');
	assert.equal(d.tier, 'fallback');
	assert.equal(d.iso3, 'eng');
	assert.equal(d.englishName, 'English');
});

test('an unresolvable primary name is still named verbatim in the fallback directive', () => {
	const d = decideResponseLanguage('ok', [], 'Klingonca');
	assert.equal(d.tier, 'fallback');
	assert.equal(d.englishName, 'Klingonca');
	assert.equal(responseLanguageDirective(d), '(Answer in Klingonca.)');
});
