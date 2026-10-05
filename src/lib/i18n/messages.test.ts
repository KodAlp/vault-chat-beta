import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import en from './messages/en.json';
import tr from './messages/tr.json';
import { LOCALES } from './locales';

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

/**
 * Every catalog on disk (not just tr/en) is held to the same contract, so a newly dropped-in language can't ship with a
 * missing key, a blank string, or a mangled {placeholder} (which would render as a literal "{name}"). Plural siblings
 * `field#zero|one|two|few|many` are the one allowed extension: language-specific extra keys whose base `field` exists.
 */
const messagesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'messages');
const catalogFiles = fs.readdirSync(messagesDir).filter((f) => f.endsWith('.json')).sort();
const PLURAL_RE = /^(.+)#(zero|one|two|few|many)$/;
const placeholders = (s: string): string => JSON.stringify([...new Set([...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].sort());
// Split on the FIRST dot only (block.field), exactly as t() does; plural field names contain '#', never '.'.
const valueAt = (o: Record<string, Record<string, unknown>>, key: string): unknown => {
	const dot = key.indexOf('.');
	return o[key.slice(0, dot)]?.[key.slice(dot + 1)];
};
const isPluralOfExisting = (k: string) => {
	const m = PLURAL_RE.exec(k);
	return m !== null && enKeys.has(`${m[1]}`) && !enKeys.has(k);
};

test('every file in messages/ is a known locale code', () => {
	const known = new Set<string>(LOCALES.map((l) => l.code));
	for (const f of catalogFiles) assert.ok(known.has(f.replace(/\.json$/, '')), `messages/${f} is not in LOCALES`);
	assert.ok(catalogFiles.includes('tr.json') && catalogFiles.includes('en.json'));
});

// A plural sibling inside en.json itself is optional elsewhere (another language may need different categories).
const requiredKeys = [...enKeys].filter((k) => !PLURAL_RE.test(k) || !enKeys.has(k.replace(PLURAL_RE, '$1')));

for (const file of catalogFiles) {
	const code = file.replace(/\.json$/, '');
	const catalog = JSON.parse(fs.readFileSync(path.join(messagesDir, file), 'utf8')) as Record<string, Record<string, unknown>>;
	const keys = flat(catalog);

	test(`${code}: has every en key and only en keys (plus plural siblings of existing keys)`, () => {
		const have = new Set(keys);
		assert.deepEqual(requiredKeys.filter((k) => !have.has(k)), [], 'missing');
		assert.deepEqual(keys.filter((k) => !enKeys.has(k) && !isPluralOfExisting(k)), [], 'unknown keys (a plural sibling needs its base key)');
	});

	test(`${code}: no empty or non-string values`, () => {
		const bad = keys.filter((k) => {
			const v = valueAt(catalog, k);
			return typeof v !== 'string' || v.trim() === '';
		});
		assert.deepEqual(bad, []);
	});

	test(`${code}: {placeholders} match en`, () => {
		const problems: string[] = [];
		for (const k of keys) {
			const v = valueAt(catalog, k);
			const variant = PLURAL_RE.exec(k);
			const baseKey = variant && !enKeys.has(k) ? variant[1] : k;
			const ref = valueAt(en as Record<string, Record<string, unknown>>, baseKey);
			if (typeof v !== 'string' || typeof ref !== 'string') continue;
			const got = placeholders(v);
			const want = placeholders(ref);
			// a plural variant may drop {count} ("one file") but must not invent or lose anything else
			const wantNoCount = placeholders(ref.replace(/\{count\}/g, ''));
			const ok = variant && !enKeys.has(k) ? got === want || got === wantNoCount : got === want;
			if (!ok) problems.push(`${k}: ${got} vs ${want}`);
		}
		assert.deepEqual(problems, []);
	});
}

/** The product is no longer positioned as Obsidian-based: Obsidian survives only as an import source's name. */
test('no catalog mentions Obsidian or "Vault Agent Toolkit" outside the import-source keys', () => {
	const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'messages');
	const isImportSourceKey = (k: string) => k.startsWith('ImportObsidianDialog.') || k.startsWith('LibrarySettingsPage.importObsidian');
	const offenders: string[] = [];
	for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.json'))) {
		const cat = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as Record<string, unknown>;
		const walk = (o: Record<string, unknown>, prefix: string) => {
			for (const [k, v] of Object.entries(o)) {
				if (typeof v === 'object' && v !== null) walk(v as Record<string, unknown>, `${prefix}${k}.`);
				else if (typeof v === 'string' && /obsidian|Vault Agent Toolkit/i.test(v) && !isImportSourceKey(`${prefix}${k}`)) offenders.push(`${f}: ${prefix}${k}`);
			}
		};
		walk(cat, '');
	}
	assert.deepEqual(offenders, []);
});

test('no .svelte file contains the old product name "Vault Agent Toolkit"', () => {
	const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
	const walk = (dir: string): string[] =>
		fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
			const p = path.join(dir, e.name);
			return e.isDirectory() ? walk(p) : e.name.endsWith('.svelte') ? [p] : [];
		});
	const bad = walk(root).filter((f) => fs.readFileSync(f, 'utf8').includes('Vault Agent Toolkit')).map((f) => path.relative(root, f));
	assert.deepEqual(bad, []);
});
