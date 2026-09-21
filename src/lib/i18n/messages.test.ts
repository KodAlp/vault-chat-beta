import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import en from './messages/en.json';
import tr from './messages/tr.json';

/**
 * The two message files must describe the same UI, and every message the code asks for by a literal key must exist. A key put in
 * the wrong block still parses as valid JSON and renders as its raw name ("StudyPanel.progress") in the running app; that is
 * exactly how one slipped through until a real browser showed it.
 */

const flat = (o: Record<string, unknown>, prefix = ''): string[] =>
	Object.entries(o).flatMap(([k, v]) => (typeof v === 'object' && v !== null ? flat(v as Record<string, unknown>, `${prefix}${k}.`) : [`${prefix}${k}`]));

const enKeys = new Set(flat(en));
const trKeys = new Set(flat(tr));

test('English and Turkish have exactly the same keys', () => {
	assert.deepEqual([...enKeys].filter((k) => !trKeys.has(k)), [], 'in en only');
	assert.deepEqual([...trKeys].filter((k) => !enKeys.has(k)), [], 'in tr only');
});

function sourceFiles(dir: string): string[] {
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) return e.name === 'node_modules' ? [] : sourceFiles(p);
		return /\.(svelte|ts)$/.test(e.name) && !/\.test\.ts$/.test(e.name) ? [p] : [];
	});
}

test('every message asked for by a literal key, t(\'Block.key\'), exists in both languages', () => {
	const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
	const blocks = new Set([...enKeys].map((k) => k.split('.')[0]));
	const used = new Map<string, string>();
	for (const file of sourceFiles(root)) {
		if (file.includes(`${path.sep}i18n${path.sep}`)) continue;
		const text = fs.readFileSync(file, 'utf8');
		for (const m of text.matchAll(/\bt\(\s*'([A-Za-z][A-Za-z0-9]*\.[A-Za-z0-9_.]+)'/g)) {
			// only keys whose block is a real message block: `t('a.b')` on some unrelated helper is not ours to check
			if (blocks.has(m[1].split('.')[0])) used.set(m[1], path.relative(root, file));
		}
	}
	assert.ok(used.size > 100, `scanned ${used.size} literal keys; the scan is broken if this is small`);
	const missing = [...used].filter(([k]) => !enKeys.has(k) || !trKeys.has(k)).map(([k, f]) => `${k} (${f})`);
	assert.deepEqual(missing, []);
});
