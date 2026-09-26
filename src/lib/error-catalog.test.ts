import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALL_ERROR_CODES, ENTITY_KEYS, REASON_KEYS } from './errors';

/**
 * Keeps src/lib/errors.ts's code/entity registry and the two i18n catalogs
 * (tr.json, en.json) from drifting apart — every code and entity must have
 * a real translation in BOTH languages, and ServerErrors must not carry
 * stale/orphaned keys nobody in errors.ts asks for any more. Read via
 * fs/path (not a static `import ... .json`) so this test — unlike
 * i18n/messages.test.ts — only concerns itself with the ServerErrors block,
 * not the whole catalog.
 */
const dir = path.dirname(fileURLToPath(import.meta.url));
const tr = JSON.parse(fs.readFileSync(path.join(dir, 'i18n', 'messages', 'tr.json'), 'utf8'));
const en = JSON.parse(fs.readFileSync(path.join(dir, 'i18n', 'messages', 'en.json'), 'utf8'));

const trErrors: Record<string, string> = tr.ServerErrors;
const enErrors: Record<string, string> = en.ServerErrors;

test('ServerErrors exists in both catalogs', () => {
	assert.ok(trErrors && typeof trErrors === 'object', 'tr.json is missing ServerErrors');
	assert.ok(enErrors && typeof enErrors === 'object', 'en.json is missing ServerErrors');
});

test('every ALL_ERROR_CODES entry has a non-empty ServerErrors string in both languages', () => {
	for (const code of ALL_ERROR_CODES) {
		assert.equal(typeof trErrors[code], 'string', `tr.json ServerErrors.${code} missing`);
		assert.ok(trErrors[code].length > 0, `tr.json ServerErrors.${code} is empty`);
		assert.equal(typeof enErrors[code], 'string', `en.json ServerErrors.${code} missing`);
		assert.ok(enErrors[code].length > 0, `en.json ServerErrors.${code} is empty`);
	}
});

test('every ENTITY_KEYS entry has a non-empty ServerErrors.entity_<name> in both languages', () => {
	for (const entity of ENTITY_KEYS) {
		const key = `entity_${entity}`;
		assert.equal(typeof trErrors[key], 'string', `tr.json ServerErrors.${key} missing`);
		assert.ok(trErrors[key].length > 0, `tr.json ServerErrors.${key} is empty`);
		assert.equal(typeof enErrors[key], 'string', `en.json ServerErrors.${key} missing`);
		assert.ok(enErrors[key].length > 0, `en.json ServerErrors.${key} is empty`);
	}
});

test('every REASON_KEYS entry has a non-empty ServerErrors.reason_<name> in both languages', () => {
	for (const reason of REASON_KEYS) {
		const key = `reason_${reason}`;
		assert.equal(typeof trErrors[key], 'string', `tr.json ServerErrors.${key} missing`);
		assert.ok(trErrors[key].length > 0, `tr.json ServerErrors.${key} is empty`);
		assert.equal(typeof enErrors[key], 'string', `en.json ServerErrors.${key} missing`);
		assert.ok(enErrors[key].length > 0, `en.json ServerErrors.${key} is empty`);
	}
});

test('ServerErrors has no orphan keys beyond ALL_ERROR_CODES, entity_* and reason_*', () => {
	const known = new Set<string>([
		...ALL_ERROR_CODES,
		...ENTITY_KEYS.map((e) => `entity_${e}`),
		...REASON_KEYS.map((r) => `reason_${r}`)
	]);
	const orphansTr = Object.keys(trErrors).filter((k) => !known.has(k));
	const orphansEn = Object.keys(enErrors).filter((k) => !known.has(k));
	assert.deepEqual(orphansTr, [], `tr.json ServerErrors has orphan keys: ${orphansTr.join(', ')}`);
	assert.deepEqual(orphansEn, [], `en.json ServerErrors has orphan keys: ${orphansEn.join(', ')}`);
});

test('tr.json and en.json ServerErrors have identical key sets', () => {
	const trKeys = Object.keys(trErrors).sort();
	const enKeys = Object.keys(enErrors).sort();
	assert.deepEqual(trKeys, enKeys);
});
