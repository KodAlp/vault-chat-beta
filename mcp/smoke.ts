import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from './create-server';

/**
 * The workhorse verification from the mcp-server skill's Tier 1: a real
 * Client against a real McpServer, in one process, no stdio involved
 * (InMemoryTransport.createLinkedPair()). Run via `npm run mcp:smoke`.
 *
 * Deliberately Ollama-independent (like npm test) — search_library's
 * embed() call is never exercised for real here, only its
 * VAULT_NOT_FOUND path, which throws before retrieve() ever calls
 * embed(). Real search_library results against a real indexed vault are
 * covered by a separate live-Ollama pass, not this fast/repeatable one.
 *
 * Never touches the real vault — seeds an isolated scratch DATA_DIR with
 * a hand-written vault entry and one real note (no index.db: list_vaults
 * reports it via `indexed: false` + `unindexedCount: 1`, while
 * search_library/list_sources — which need an actual query result, not a
 * status summary — report the distinct NOT_INDEXED error instead of a
 * silent empty success; see retrieve.ts's vaultIsIndexed(). get_note works
 * regardless of indexing, since it reads the filesystem directly).
 *
 * `default` is seeded `mcpExposed: true` (İ6, Aşama 8) so the rest of this
 * file keeps exercising every OTHER path (NOT_INDEXED, traversal, unknown
 * vault, ...) rather than every call short-circuiting on the new exposure
 * gate — `closed` below is the vault that actually tests that gate.
 */
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-chat-mcp-smoke-'));
process.env.DATA_DIR = scratch;

const now = new Date().toISOString();
fs.writeFileSync(
	path.join(scratch, 'vaults.json'),
	JSON.stringify({
		vaults: [
			{ id: 'default', name: 'Smoke Test', path: 'default', createdAt: now, lastOpenedAt: now, mcpExposed: true },
			{ id: 'closed', name: 'Closed Vault', path: 'closed', createdAt: now, lastOpenedAt: now, mcpExposed: false }
		],
		activeVaultId: 'default',
		mcpMigrationAsked: true
	})
);
const libraryRoot = path.join(scratch, 'vaults', 'default', 'library');
fs.mkdirSync(libraryRoot, { recursive: true });
fs.writeFileSync(
	path.join(libraryRoot, 'note.md'),
	'---\ntitle: Test Notu\ndomain: test\nlevel: undergrad\n---\n\n# Test\n\nİçerik.'
);
fs.mkdirSync(path.join(scratch, 'vaults', 'closed', 'library'), { recursive: true });

try {
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const server = createServer();
	const client = new Client({ name: 'smoke-test', version: '0.0.0' });

	await server.connect(serverTransport);
	await client.connect(clientTransport);

	const { tools } = await client.listTools();
	assert.equal(tools.length, 4, `expected 4 registered tools, got ${tools.length}`);
	const names = tools.map((t) => t.name).sort();
	assert.deepEqual(names, ['get_note', 'list_sources', 'list_vaults', 'search_library']);
	for (const t of tools) {
		assert.equal(t.annotations?.readOnlyHint, true, `${t.name} must be marked readOnlyHint`);
		assert.equal(t.annotations?.destructiveHint, false, `${t.name} must be marked destructiveHint:false`);
	}
	console.log('ok - tools/list returns all 4 tools, all readOnlyHint');

	// list_vaults
	{
		const result = await client.callTool({ name: 'list_vaults', arguments: {} });
		assert.equal(result.isError, undefined, 'list_vaults should not return an error');
		const content = result.content as { type: string; text: string }[];
		const parsed = JSON.parse(content[0].text) as {
			vaults: { id: string; active: boolean; indexed: boolean; noteCount: number; unindexedCount: number }[];
		};
		assert.equal(parsed.vaults.length, 1);
		assert.equal(parsed.vaults[0].active, true, 'the only vault falls back to active via getActiveVaultId()');
		assert.equal(parsed.vaults[0].indexed, false, 'never-indexed vault must not throw or report indexed:true');
		assert.equal(parsed.vaults[0].unindexedCount, 1, 'the one real .md file on disk, never indexed, must be counted');
		console.log('ok - list_vaults returns the seeded vault, correctly reporting it as unindexed (unindexedCount: 1)');
	}

	// get_note — happy path
	{
		const result = await client.callTool({ name: 'get_note', arguments: { path: 'note.md' } });
		assert.equal(result.isError, undefined, 'get_note should not error for a real file');
		const content = result.content as { type: string; text: string }[];
		const parsed = JSON.parse(content[0].text) as { frontmatter: { title: string }; content: string };
		assert.equal(parsed.frontmatter.title, 'Test Notu');
		assert.ok(parsed.content.includes('İçerik'), 'body should contain the note text, frontmatter stripped');
		console.log('ok - get_note returns parsed frontmatter + body for a real file');
	}

	// get_note — traversal rejection
	{
		const result = await client.callTool({ name: 'get_note', arguments: { path: '../../../../etc/passwd' } });
		assert.equal(result.isError, true, 'a traversal attempt must return isError, not throw or succeed');
		const text = (result.content as { type: string; text: string }[])[0].text;
		assert.ok(text.startsWith('PATH_OUTSIDE_LIBRARY:'), `expected PATH_OUTSIDE_LIBRARY, got: ${text}`);
		console.log('ok - get_note rejects a traversal attempt with PATH_OUTSIDE_LIBRARY');
	}

	// get_note — missing file
	{
		const result = await client.callTool({ name: 'get_note', arguments: { path: 'does-not-exist.md' } });
		assert.equal(result.isError, true);
		const text = (result.content as { type: string; text: string }[])[0].text;
		assert.ok(text.startsWith('NOTE_NOT_FOUND:'), `expected NOTE_NOT_FOUND, got: ${text}`);
		console.log('ok - get_note reports NOTE_NOT_FOUND for a missing file, not a raw ENOENT');
	}

	// list_sources / search_library — unindexed vault reports NOT_INDEXED,
	// not a silent empty success (Ö7, 2026-09-23 report: `{"results":[]},
	// isError:false` from an unindexed vault used to be indistinguishable
	// from "searched, nothing matched" — NOT_INDEXED existed in errors.ts
	// from the start, nothing ever produced it).
	{
		const result = await client.callTool({ name: 'list_sources', arguments: {} });
		assert.equal(result.isError, true, 'list_sources on an unindexed vault must be a distinct error, not empty success');
		const text = (result.content as { type: string; text: string }[])[0].text;
		assert.ok(text.startsWith('NOT_INDEXED:'), `expected NOT_INDEXED, got: ${text}`);
		console.log('ok - list_sources reports NOT_INDEXED for an unindexed vault (was isError:false, empty results)');
	}
	{
		const result = await client.callTool({ name: 'search_library', arguments: { query: 'test' } });
		assert.equal(result.isError, true, 'search_library on an unindexed vault must be a distinct error, not empty success');
		const text = (result.content as { type: string; text: string }[])[0].text;
		assert.ok(text.startsWith('NOT_INDEXED:'), `expected NOT_INDEXED, got: ${text}`);
		console.log('ok - search_library reports NOT_INDEXED for an unindexed vault');
	}

	// unknown vault — every vault-scoped tool must report VAULT_NOT_FOUND, never throw
	for (const name of ['search_library', 'get_note', 'list_sources']) {
		const args = name === 'search_library' ? { vault: 'nope', query: 'x' } : name === 'get_note' ? { vault: 'nope', path: 'x.md' } : { vault: 'nope' };
		const result = await client.callTool({ name, arguments: args });
		assert.equal(result.isError, true, `${name} with an unknown vault must return isError`);
		const text = (result.content as { type: string; text: string }[])[0].text;
		assert.ok(text.startsWith('VAULT_NOT_FOUND:'), `${name}: expected VAULT_NOT_FOUND, got: ${text}`);
	}
	console.log('ok - every vault-scoped tool reports VAULT_NOT_FOUND for an unknown vault id (never throws)');

	// İ6 (Aşama 8): a vault that exists but was never opened to external
	// clients must be both invisible to discovery (list_vaults, already
	// asserted length 1 above — 'closed' is the second, unlisted vault) and
	// unreachable by every other tool even when the id is known outright —
	// guessing "default"-style ids at a closed vault must not work either.
	for (const name of ['search_library', 'get_note', 'list_sources']) {
		const args =
			name === 'search_library'
				? { vault: 'closed', query: 'x' }
				: name === 'get_note'
					? { vault: 'closed', path: 'x.md' }
					: { vault: 'closed' };
		const result = await client.callTool({ name, arguments: args });
		assert.equal(result.isError, true, `${name} against a closed vault must return isError`);
		const text = (result.content as { type: string; text: string }[])[0].text;
		assert.ok(text.startsWith('VAULT_NOT_EXPOSED:'), `${name}: expected VAULT_NOT_EXPOSED, got: ${text}`);
	}
	console.log('ok - every vault-scoped tool reports VAULT_NOT_EXPOSED for a vault that exists but is not opened to MCP');

	const logPath = path.join(scratch, 'mcp-log.jsonl');
	assert.ok(fs.existsSync(logPath), 'mcp-log.jsonl should exist after these calls');
	const logLines = fs
		.readFileSync(logPath, 'utf-8')
		.trim()
		.split('\n')
		.map((l) => JSON.parse(l) as { tool: string; params: Record<string, unknown> });
	assert.ok(logLines.length >= 7, `expected at least 7 log lines, got ${logLines.length}`);
	const searchLine = logLines.find((l) => l.tool === 'search_library');
	assert.ok(searchLine, 'search_library call should be logged even though it never reached embed()');
	assert.ok(!('query' in searchLine.params), 'the raw query string must never be logged, only queryChars');
	console.log('ok - mcp-log.jsonl recorded every call, and never logs a raw query string');

	console.log('smoke test passed');
} finally {
	fs.rmSync(scratch, { recursive: true, force: true });
}
