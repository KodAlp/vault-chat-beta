import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decideMcpGate } from '../src/lib/server/mcp-gate';

/**
 * Structural lock for "an MCP client can never change the auto-confirm setting".
 * The setting (vault.mcpAutoConfirm) is a standing instruction from the USER that
 * makes the APP confirm MCP imports. If the agent could switch it on, the safety
 * property "the agent cannot confirm" would be hollow. Its only writer is the
 * session-gated PATCH /api/vaults/[id]; this test checks that:
 *  1. nothing in mcp/ or under src/routes/api/mcp/ (nor anything they import)
 *     mentions the setter or the field,
 *  2. the MCP client can only reach /api/mcp/* and only with GET/POST,
 *  3. the MCP token is worthless on the settings route (the gate only opens /api/mcp/*),
 *  4. exactly one route handler calls the setter, and it lives outside /api/mcp/.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const routesDir = path.join(repo, 'src', 'routes');
const SETTER_FILE = path.join(repo, 'src', 'lib', 'server', 'vaults.ts');
const TYPES_FILE = path.join(repo, 'src', 'lib', 'types.ts');
// The exposure setter is equally off limits: closing/opening a vault also withdraws or resumes MCP reach.
const FORBIDDEN_IDENTS = /setVaultMcpAutoConfirm|setVaultMcpExposed|mcpAutoConfirm/;

function listTs(dir: string, filter: (name: string) => boolean): string[] {
	const out: string[] = [];
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		if (e.name === 'node_modules') continue;
		const p = path.join(dir, e.name);
		if (e.isDirectory()) out.push(...listTs(p, filter));
		else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') && filter(e.name)) out.push(p);
	}
	return out;
}

function resolveImport(from: string, spec: string): string | null {
	let base: string;
	if (spec.startsWith('$lib/')) base = path.join(repo, 'src', 'lib', spec.slice(5));
	else if (spec.startsWith('.')) base = path.resolve(path.dirname(from), spec);
	else return null;
	for (const cand of [base, base + '.ts', path.join(base, 'index.ts')]) {
		if (fs.existsSync(cand) && fs.statSync(cand).isFile()) return cand;
	}
	return null;
}

const IMPORT_RE = /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;

function reachable(entries: string[]): Set<string> {
	const seen = new Set<string>(entries);
	const queue = [...entries];
	while (queue.length) {
		const f = queue.pop() as string;
		const src = fs.readFileSync(f, 'utf-8');
		for (const m of src.matchAll(IMPORT_RE)) {
			const target = resolveImport(f, m[1] ?? m[2] ?? m[3]);
			if (target && !seen.has(target)) {
				seen.add(target);
				queue.push(target);
			}
		}
	}
	return seen;
}

const mcpRouteFiles = listTs(path.join(routesDir, 'api', 'mcp'), () => true);
const mcpClientFiles = listTs(here, () => true);

test('the scan sees the MCP surface (sanity)', () => {
	assert.ok(mcpRouteFiles.some((f) => f.endsWith(path.join('imports', '+server.ts'))));
	assert.ok(mcpClientFiles.some((f) => f.endsWith(path.join('tools', 'import-source.ts'))));
});

test('no MCP entry point, and nothing it imports, mentions the auto-confirm / exposure setters or the field', () => {
	const seen = reachable([...mcpRouteFiles, ...mcpClientFiles]);
	assert.ok(seen.has(SETTER_FILE), 'sanity: vaults.ts is reachable (create_vault), so the check below is meaningful');
	const offenders = [...seen]
		.filter((f) => f !== SETTER_FILE) // vaults.ts defines the setters; what matters is who CALLS them
		.filter((f) => f !== TYPES_FILE) // a type-only mirror of the field for the settings page
		.filter((f) => FORBIDDEN_IDENTS.test(fs.readFileSync(f, 'utf-8')))
		.map((f) => path.relative(repo, f));
	assert.deepEqual(offenders, []);
});

test('the setters in vaults.ts are not called by anything reachable from the MCP surface', () => {
	// vaults.ts itself is reachable; its only internal use of the exposure setter's name is the definition.
	const src = fs.readFileSync(SETTER_FILE, 'utf-8').replaceAll('\r\n', '\n');
	const calls = [...src.matchAll(/\b(setVaultMcpAutoConfirm|setVaultMcpExposed)\(/g)].length;
	assert.equal(calls, 2, 'vaults.ts only defines the two setters, it never calls them');
	// createVaultViaMcp is the only vaults.ts function the MCP routes use; it must not touch the new field.
	const via = /export function createVaultViaMcp[\s\S]*?\n}\n/.exec(src)?.[0] ?? '';
	assert.ok(via.length > 0);
	assert.ok(!/mcpAutoConfirm/.test(via));
});

test('the MCP client only talks to /api/mcp/* and only with GET or POST', () => {
	const client = fs.readFileSync(path.join(here, 'app-client.ts'), 'utf-8');
	assert.match(client, /method: 'GET' \| 'POST'/);
	for (const f of listTs(path.join(here, 'tools'), () => true)) {
		for (const m of fs.readFileSync(f, 'utf-8').matchAll(/appRequest<[^>]*>\(\s*'(GET|POST)',\s*([^,)]+)/g)) {
			assert.match(m[2], /^[`']\/api\/mcp\//, `${path.relative(repo, f)} calls ${m[2]}`);
		}
	}
});

test('the MCP token is worthless on the vault settings route', () => {
	const input = { token: 'secret', headerToken: 'secret', origin: null };
	assert.deepEqual(decideMcpGate({ ...input, pathname: '/api/vaults/default' }), { kind: 'not-mcp' });
	assert.deepEqual(decideMcpGate({ ...input, pathname: '/api/vaults' }), { kind: 'not-mcp' });
	assert.deepEqual(decideMcpGate({ ...input, pathname: '/api/settings/mcp' }), { kind: 'not-mcp' });
	assert.equal(decideMcpGate({ ...input, pathname: '/api/mcp/imports' }).kind, 'allow');
});

test('exactly one route calls the auto-confirm setter, and it is not under /api/mcp/', () => {
	const callers = listTs(routesDir, () => true).filter((f) => /setVaultMcpAutoConfirm\(/.test(fs.readFileSync(f, 'utf-8')));
	assert.deepEqual(
		callers.map((f) => path.relative(routesDir, f).split(path.sep).join('/')),
		['api/vaults/[id]/+server.ts']
	);
});
