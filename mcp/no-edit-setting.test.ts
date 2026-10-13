import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Structural lock for the edit_note developer switch (mcp-settings.ts `allowEditNote`): an MCP client must
 * never be able to switch it on for itself, and the app (not the MCP process) is the enforcer.
 * Complements no-auto-confirm-write.test.ts (same idea for the auto-confirm setting) and
 * no-write-import.test.ts (mcp/ cannot import library-write.ts).
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const routesDir = path.join(repo, 'src', 'routes');

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
const read = (f: string) => fs.readFileSync(f, 'utf-8').replaceAll('\r\n', '\n');
const rel = (f: string) => path.relative(repo, f).split(path.sep).join('/');

test('nothing under mcp/ reads or writes the settings file or the switch', () => {
	const offenders = listTs(here).filter((f) => /allowEditNote|writeMcpSettings|readMcpSettings/.test(read(f)));
	assert.deepEqual(offenders.map(rel), []);
});

test('no /api/mcp/* route can write the settings; only PUT /api/settings/mcp does', () => {
	const mcpRoutes = listTs(path.join(routesDir, 'api', 'mcp'));
	assert.ok(mcpRoutes.some((f) => rel(f).endsWith('notes/edit/+server.ts')), 'sanity: the edit route exists');
	assert.deepEqual(mcpRoutes.filter((f) => /writeMcpSettings/.test(read(f))).map(rel), []);
	const writers = listTs(routesDir).filter((f) => /writeMcpSettings\(/.test(read(f)));
	assert.deepEqual(writers.map((f) => path.relative(routesDir, f).split(path.sep).join('/')), ['api/settings/mcp/+server.ts']);
});

test('the edit route checks the switch before it reads the request or touches a vault', () => {
	const src = read(path.join(routesDir, 'api', 'mcp', 'notes', 'edit', '+server.ts'));
	const gate = src.indexOf('allowEditNote');
	assert.ok(gate > 0);
	assert.ok(gate < src.indexOf('request.json'));
	assert.ok(gate < src.indexOf('requireMcpVault('));
	assert.match(src, /fail\('MCP_EDIT_NOTE_DISABLED'/);
});

test('the tool only talks to /api/mcp/* with POST and never claims to enforce the switch itself', () => {
	const src = read(path.join(here, 'tools', 'edit-note.ts'));
	assert.match(src, /appRequest<[^>]*>\('POST', '\/api\/mcp\/notes\/edit'/);
	assert.ok(!/allowEditNote/.test(src));
});
