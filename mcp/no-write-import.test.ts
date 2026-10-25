import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Structural lock for "the AI cannot write to the library". The MCP server is
 * the only door an AI client has into the vault; manual editing lives in
 * src/lib/server/library-write.ts, which must never be reachable from mcp/.
 * This walks every .ts file under mcp/ and follows relative and #lib imports
 * transitively (static import/export-from and dynamic import('...')), so a
 * future indirect path (mcp -> X -> Y -> library-write) is caught too.
 *
 * library.ts (delete/rename/settings/import writers) is locked out as well: it
 * is not reachable from mcp/ today (library-read.ts exists precisely for that).
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const FORBIDDEN = path.join(repo, 'src', 'lib', 'server', 'library-write.ts');
const FORBIDDEN_LIBRARY = path.join(repo, 'src', 'lib', 'server', 'library.ts');

function listTs(dir: string): string[] {
	const out: string[] = [];
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		if (e.name === 'node_modules') continue;
		const p = path.join(dir, e.name);
		if (e.isDirectory()) out.push(...listTs(p));
		else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) out.push(p);
	}
	return out;
}

function resolveImport(from: string, spec: string): string | null {
	let base: string;
	if (spec.startsWith('#lib/')) base = path.join(repo, 'src', 'lib', spec.slice(5));
	else if (spec.startsWith('.')) base = path.resolve(path.dirname(from), spec);
	else return null; // bare package specifier
	// `#lib/x.js` and `./x.js` name the TypeScript source x.ts (TS ESM convention).
	const ts = base.replace(/.js$/, '.ts');
	for (const cand of [ts, base, base + '.ts', path.join(base, 'index.ts')]) {
		if (fs.existsSync(cand) && fs.statSync(cand).isFile()) return cand;
	}
	return null;
}

const IMPORT_RE = /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;

function importsOf(file: string): string[] {
	const src = fs.readFileSync(file, 'utf-8');
	const specs: string[] = [];
	for (const m of src.matchAll(IMPORT_RE)) specs.push(m[1] ?? m[2] ?? m[3]);
	return specs;
}

/** file -> the file that first imported it (for a readable failure message). */
function reachable(entries: string[]): Map<string, string> {
	const seen = new Map<string, string>();
	const queue = [...entries];
	for (const e of entries) seen.set(e, '(mcp entry)');
	while (queue.length) {
		const f = queue.pop() as string;
		for (const spec of importsOf(f)) {
			const target = resolveImport(f, spec);
			if (target && !seen.has(target)) {
				seen.set(target, f);
				queue.push(target);
			}
		}
	}
	return seen;
}

test('the walker follows the MCP read path (sanity: library-read is reachable)', () => {
	const seen = reachable(listTs(here));
	assert.ok(seen.has(path.join(repo, 'src', 'lib', 'server', 'library-read.ts')));
});

test('the walker resolves #lib imports written with a .js extension (sanity)', () => {
	// SvelteKit 3 imports look like `#lib/server/x.js` for x.ts. If the resolver stopped following
	// them, every transitive path through src/lib would silently drop out of the checks below.
	const from = path.join(repo, 'src', 'lib', 'server', 'library-read.ts');
	assert.equal(resolveImport(from, '#lib/server/library-write.js'), FORBIDDEN);
	assert.equal(resolveImport(from, './library.js'), FORBIDDEN_LIBRARY);
});

test('nothing under mcp/ can reach library-write.ts', () => {
	const seen = reachable(listTs(here));
	if (seen.has(FORBIDDEN)) {
		const chain: string[] = [];
		for (let f: string | undefined = FORBIDDEN; f && f !== '(mcp entry)'; f = seen.get(f)) chain.unshift(path.relative(repo, f));
		assert.fail('mcp/ reaches library-write.ts via: ' + chain.join(' -> '));
	}
});

test('nothing under mcp/ can reach library.ts either (delete/rename/settings writers)', () => {
	assert.ok(!reachable(listTs(here)).has(FORBIDDEN_LIBRARY));
});

test('the walker would catch a violation (library-write is reachable from itself)', () => {
	assert.ok(reachable([FORBIDDEN]).has(FORBIDDEN));
	assert.ok(reachable([FORBIDDEN]).has(path.join(repo, 'src', 'lib', 'server', 'incrementalIndex.ts')));
});
