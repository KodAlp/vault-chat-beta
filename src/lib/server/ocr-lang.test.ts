import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ocrLangArg, sanitizeOcrLang } from './ocr-lang';
import { buildConvertArgs } from './convertQueue';

test('vault languages are forwarded as text; convert.py maps the names', () => {
	assert.equal(ocrLangArg(undefined, ['Türkçe']), 'Türkçe');
	assert.equal(ocrLangArg(undefined, ['Türkçe', 'English']), 'Türkçe, English');
	assert.equal(ocrLangArg(null, []), undefined);
	assert.equal(ocrLangArg('', undefined), undefined);
});

test('a per-import choice wins over the vault; "auto" and empty fall back to the vault', () => {
	assert.equal(ocrLangArg('de', ['Türkçe']), 'de');
	assert.equal(ocrLangArg('auto', ['Türkçe']), 'Türkçe');
	assert.equal(ocrLangArg('  ', ['English']), 'English');
});

test('sanitizing keeps letters of any script and drops anything that could act as a flag or shell syntax', () => {
	assert.equal(sanitizeOcrLang('--pdf-backend hybrid'), 'pdf-backend hybrid');
	assert.equal(sanitizeOcrLang('tr; rm -rf /'), 'tr rm -rf');
	assert.equal(sanitizeOcrLang('বাংলা'), 'বাংলা');
	assert.equal(sanitizeOcrLang(42), undefined);
	assert.equal(sanitizeOcrLang('x'.repeat(500))!.length, 80);
});

test('buildConvertArgs passes --ocr-lang only when given, after the existing flags', () => {
	assert.deepEqual(buildConvertArgs('a.pdf', 'out', 'auto', 'n.pdf', undefined, undefined, 'tr,en'), [
		'--in', 'a.pdf', '--out-dir', 'out', '--tool', 'auto', '--source-name', 'n.pdf', '--ocr-lang', 'tr,en'
	]);
	assert.ok(!buildConvertArgs('a.pdf', 'out', 'auto').includes('--ocr-lang'));
	assert.deepEqual(buildConvertArgs('a.pdf', 'out', 'auto', undefined, '1-2', 'hybrid', 'tr').slice(-6), [
		'--pages', '1-2', '--pdf-backend', 'hybrid', '--ocr-lang', 'tr'
	]);
});
