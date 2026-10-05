import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pluralCategory, resolveMessage, type MessageTree } from './resolve';

const tr: MessageTree = { A: { only: 'yalnız tr', both: 'iki dil tr', files: '{count} dosya' } };
const en: MessageTree = {
	A: { both: 'both en', enOnly: 'en only', files: '{count} files', 'files#one': '{count} file', empty: 'en text' }
};
const ar: MessageTree = { A: { both: 'ar' } };
const arEG: MessageTree = { A: { empty: '' } };
const ru: MessageTree = {
	A: { files: '{count} файла', 'files#one': '{count} файл', 'files#few': '{count} файла', 'files#many': '{count} файлов' }
};

const chain = (...pairs: [string, MessageTree | undefined][]) => pairs;

test('current locale wins, then parent, then en, then tr, then the raw key', () => {
	const c = chain(['ar-EG', arEG], ['ar', ar], ['en', en], ['tr', tr]);
	assert.equal(resolveMessage(c, 'A.both'), 'ar');
	assert.equal(resolveMessage(c, 'A.enOnly'), 'en only');
	assert.equal(resolveMessage(c, 'A.only'), 'yalnız tr');
	assert.equal(resolveMessage(c, 'A.nope'), 'A.nope');
	assert.equal(resolveMessage(c, 'Nope.x'), 'Nope.x');
});

test('an empty string counts as missing and falls through', () => {
	assert.equal(resolveMessage(chain(['ar-EG', arEG], ['en', en]), 'A.empty'), 'en text');
});

test('a catalog that has not loaded yet (undefined) is skipped', () => {
	assert.equal(resolveMessage(chain(['de', undefined], ['en', en], ['tr', tr]), 'A.both'), 'both en');
});

test('{param} substitution; unknown placeholders stay literal', () => {
	assert.equal(resolveMessage(chain(['en', en]), 'A.files', { count: 5 }), '5 files');
	assert.equal(resolveMessage(chain(['en', { A: { x: 'hi {name} {other}' } }]), 'A.x', { name: 'Al' }), 'hi Al {other}');
});

test('plural: English one/other', () => {
	const c = chain(['en', en]);
	assert.equal(resolveMessage(c, 'A.files', { count: 1 }), '1 file');
	assert.equal(resolveMessage(c, 'A.files', { count: 2 }), '2 files');
});

test('plural: Russian one/few/many/other via Intl.PluralRules', () => {
	const c = chain(['ru', ru], ['en', en]);
	assert.equal(resolveMessage(c, 'A.files', { count: 1 }), '1 файл');
	assert.equal(resolveMessage(c, 'A.files', { count: 3 }), '3 файла');
	assert.equal(resolveMessage(c, 'A.files', { count: 5 }), '5 файлов');
	assert.equal(resolveMessage(c, 'A.files', { count: 21 }), '21 файл');
	assert.equal(resolveMessage(c, 'A.files', { count: 1.5 }), '1.5 файла');
});

test('plural variant comes from the SAME catalog as the base: ru base without variants beats en#one', () => {
	const ruNoVariants: MessageTree = { A: { files: '{count} файлов' } };
	assert.equal(resolveMessage(chain(['ru', ruNoVariants], ['en', en]), 'A.files', { count: 1 }), '1 файлов');
});

test('plural falls through to the next catalog when the current one has neither base nor variant', () => {
	assert.equal(resolveMessage(chain(['de', { A: {} }], ['en', en]), 'A.files', { count: 1 }), '1 file');
});

test('no numeric count -> plural variants are ignored', () => {
	const c = chain(['en', en]);
	assert.equal(resolveMessage(c, 'A.files', { count: '1' }), '1 files');
	assert.equal(resolveMessage(c, 'A.files'), '{count} files');
});

test('pluralCategory: unknown locale falls back to English rules instead of throwing', () => {
	assert.equal(pluralCategory('not a tag!!', 1), 'one');
	assert.equal(['one', 'other'].includes(pluralCategory('pcm', 1)), true);
	assert.equal(pluralCategory('ar', 2), 'two');
	assert.equal(pluralCategory('ja', 1), 'other');
});
