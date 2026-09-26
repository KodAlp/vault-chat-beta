import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatCodedError } from './error-format';
import type { ErrorParams } from './errors';

/**
 * A tiny fake translate() standing in for the real i18n t() (which this
 * file can't import — it's a runed module, see i18n/index.svelte.ts's own
 * doc comment on why that breaks under tsx --test). Mirrors t()'s
 * documented missing-key contract: return the raw key, and do {name}
 * substitution when params are given.
 */
const DICT: Record<string, string> = {
	'ServerErrors.NOT_FOUND': '{entity} bulunamadı',
	'ServerErrors.entity_quiz': 'Sınav',
	'ServerErrors.PROVIDER_AUTH': '{provider}: API anahtarı geçersiz veya eksik',
	'ServerErrors.UNKNOWN': 'Beklenmeyen bir hata oluştu',
	'ServerErrors.GEN_REPORT_INVALID': 'Rapor üretilemedi',
	'ServerErrors.PINNED': '{provider} {reason} → zincir',
	'ServerErrors.reason_invalid_json': 'Model geçerli JSON döndürmedi',
	'ServerErrors.reason_disabled': 'devre dışı'
};

test('a known reason without a template slot is resolved and appended', () => {
	const result = formatCodedError({ code: 'GEN_REPORT_INVALID', params: { reason: 'invalid_json' } }, fakeTranslate, 'fb');
	assert.equal(result, 'Rapor üretilemedi — Model geçerli JSON döndürmedi');
});

test('a known reason with a template slot is interpolated, not appended again', () => {
	const result = formatCodedError({ code: 'PINNED', params: { provider: 'groq', reason: 'disabled' } }, fakeTranslate, 'fb');
	assert.equal(result, 'groq devre dışı → zincir');
});

test('an unknown reason token is still shown rather than dropped', () => {
	const result = formatCodedError({ code: 'GEN_REPORT_INVALID', params: { reason: 'weird_case' } }, fakeTranslate, 'fb');
	assert.equal(result, 'Rapor üretilemedi — weird_case');
});

function fakeTranslate(key: string, params?: ErrorParams): string {
	const template = DICT[key];
	if (template === undefined) return key;
	if (!params) return template;
	return template.replace(/\{(\w+)\}/g, (m, name: string) => (name in params ? String(params[name]) : m));
}

test('a coded error with a known translation renders the translated text', () => {
	const result = formatCodedError({ code: 'UNKNOWN' }, fakeTranslate, 'fallback');
	assert.equal(result, 'Beklenmeyen bir hata oluştu');
});

test('a coded error with no matching catalog entry falls through to message', () => {
	const result = formatCodedError({ code: 'NO_SUCH_CODE', message: 'raw provider text' }, fakeTranslate, 'fallback');
	assert.equal(result, 'raw provider text');
});

test('a message that is itself a bare code (no known translation, no usable message) falls through to fallback', () => {
	const result = formatCodedError({ code: 'NO_SUCH_CODE', message: 'SOME_OTHER_CODE' }, fakeTranslate, 'fallback');
	assert.equal(result, 'fallback');
});

test('entity param is resolved through ServerErrors.entity_<name> before interpolation', () => {
	const result = formatCodedError({ code: 'NOT_FOUND', params: { entity: 'quiz' } }, fakeTranslate, 'fallback');
	assert.equal(result, 'Sınav bulunamadı');
});

test('an entity with no matching entity_<name> translation is interpolated as-is', () => {
	const result = formatCodedError({ code: 'NOT_FOUND', params: { entity: 'widget' } }, fakeTranslate, 'fallback');
	assert.equal(result, 'widget bulunamadı');
});

test('a detail param is appended after the translated text with an em-dash', () => {
	const result = formatCodedError({ code: 'PROVIDER_AUTH', params: { provider: 'Groq', detail: 'invalid_api_key' } }, fakeTranslate, 'fallback');
	assert.equal(result, 'Groq: API anahtarı geçersiz veya eksik — invalid_api_key');
});

test('a detail already contained in the translated text is not duplicated', () => {
	const result = formatCodedError(
		{ code: 'PROVIDER_AUTH', params: { provider: 'Groq', detail: 'API anahtarı geçersiz veya eksik' } },
		fakeTranslate,
		'fallback'
	);
	assert.equal(result, 'Groq: API anahtarı geçersiz veya eksik');
});

test('no code but a usable plain-prose message returns the message', () => {
	const result = formatCodedError({ message: 'Something specific broke.' }, fakeTranslate, 'fallback');
	assert.equal(result, 'Something specific broke.');
});

test('no code and a message that looks like a bare code falls through to fallback', () => {
	const result = formatCodedError({ message: 'SOME_CODE' }, fakeTranslate, 'fallback');
	assert.equal(result, 'fallback');
});

test('null input returns the fallback', () => {
	assert.equal(formatCodedError(null, fakeTranslate, 'fallback'), 'fallback');
});

test('undefined input returns the fallback', () => {
	assert.equal(formatCodedError(undefined, fakeTranslate, 'fallback'), 'fallback');
});

test('an empty-string message does not count as usable and falls through to fallback', () => {
	assert.equal(formatCodedError({ message: '' }, fakeTranslate, 'fallback'), 'fallback');
});
