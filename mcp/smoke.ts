import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from './create-server';
import { writeMcpEndpoint, mcpEndpointPath } from '../src/lib/server/mcp-endpoint';

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
	assert.equal(tools.length, 7, `expected 7 registered tools, got ${tools.length}`);
	const names = tools.map((t) => t.name).sort();
	assert.deepEqual(names, [
		'create_vault',
		'get_note',
		'import_source',
		'list_pending_imports',
		'list_sources',
		'list_vaults',
		'search_library'
	]);
	// Write tools reach the app over HTTP: create_vault/import_source change state (readOnlyHint false) but never
	// destroy anything; only import_source touches the open world (it fetches URLs). list_pending_imports only reads.
	const expectedAnnotations: Record<string, { readOnlyHint: boolean; openWorldHint: boolean }> = {
		create_vault: { readOnlyHint: false, openWorldHint: false },
		import_source: { readOnlyHint: false, openWorldHint: true },
		list_pending_imports: { readOnlyHint: true, openWorldHint: false }
	};
	for (const t of tools) {
		const want = expectedAnnotations[t.name] ?? { readOnlyHint: true, openWorldHint: false };
		assert.equal(t.annotations?.readOnlyHint, want.readOnlyHint, `${t.name} readOnlyHint`);
		assert.equal(t.annotations?.openWorldHint, want.openWorldHint, `${t.name} openWorldHint`);
		assert.equal(t.annotations?.destructiveHint, false, `${t.name} must be marked destructiveHint:false`);
	}
	console.log('ok - tools/list returns all 7 tools with the right annotations (5 read-only, 2 write tools not)');

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

	// ---- write tools: they only ever talk to the running app over HTTP (app-client.ts) ----
	const text = (r: unknown): string => (r as { content: { text: string }[] }).content[0].text;
	const writeCalls: { name: string; arguments: Record<string, unknown> }[] = [
		{ name: 'create_vault', arguments: { name: 'Gizli Kasa Adı' } },
		{ name: 'import_source', arguments: { vault: 'default', url: 'https://example.com/secret-article' } },
		{ name: 'list_pending_imports', arguments: { vault: 'default' } }
	];

	// No endpoint file at all: the app is not running.
	assert.ok(!fs.existsSync(mcpEndpointPath(scratch)));
	for (const call of writeCalls) {
		const r = await client.callTool(call);
		assert.equal(r.isError, true, `${call.name} without an app must return isError`);
		assert.ok(text(r).startsWith('APP_NOT_RUNNING:'), `${call.name}: expected APP_NOT_RUNNING, got: ${text(r)}`);
	}
	console.log('ok - create_vault/import_source/list_pending_imports return APP_NOT_RUNNING when there is no mcp-endpoint.json');

	// import_source argument rule is checked before any network call: exactly one of path/url.
	{
		const both = await client.callTool({ name: 'import_source', arguments: { path: '/a.pdf', url: 'https://example.com/a' } });
		assert.ok(text(both).startsWith('INVALID_ARGUMENTS:'), text(both));
		const neither = await client.callTool({ name: 'import_source', arguments: {} });
		assert.ok(text(neither).startsWith('INVALID_ARGUMENTS:'), text(neither));
		console.log('ok - import_source requires exactly one of path/url');
	}

	// A stale file (dead pid) is also "not running".
	writeMcpEndpoint(scratch, { url: 'http://127.0.0.1:9', mcpToken: 'f'.repeat(64), pid: 2147483646, startedAt: now });
	{
		const r = await client.callTool(writeCalls[0]);
		assert.ok(text(r).startsWith('APP_NOT_RUNNING:'), text(r));
	}
	// A live pid but nothing listening on the port (crashed app, reused pid): connection refused -> APP_NOT_RUNNING.
	{
		const closed = http.createServer();
		await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
		const deadPort = (closed.address() as AddressInfo).port;
		await new Promise<void>((resolve) => closed.close(() => resolve()));
		writeMcpEndpoint(scratch, { url: `http://127.0.0.1:${deadPort}`, mcpToken: 'f'.repeat(64), pid: process.pid, startedAt: now });
		const r = await client.callTool(writeCalls[0]);
		assert.ok(text(r).startsWith('APP_NOT_RUNNING:'), text(r));
	}
	console.log('ok - a stale pid and a refused connection both report APP_NOT_RUNNING');

	// A fake app on a real loopback port: checks forwarding, the token header, and error mapping.
	const MCP_TOKEN = 'ab'.repeat(32);
	const seen: { method: string; url: string; token: string | undefined; origin: string | undefined; body: string }[] = [];
	const fakeApp = http.createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on('data', (c: Buffer) => chunks.push(c));
		req.on('end', () => {
			const body = Buffer.concat(chunks).toString('utf-8');
			seen.push({
				method: req.method ?? '',
				url: req.url ?? '',
				token: req.headers['x-vc-mcp-token'] as string | undefined,
				origin: req.headers.origin,
				body
			});
			const reply = (status: number, payload: unknown) => {
				res.writeHead(status, { 'content-type': 'application/json' });
				res.end(JSON.stringify(payload));
			};
			if (req.headers['x-vc-mcp-token'] !== MCP_TOKEN) return reply(401, { message: 'MCP_TOKEN_REQUIRED', code: 'MCP_TOKEN_REQUIRED' });
			if (req.method === 'POST' && req.url === '/api/mcp/vaults') {
				const { name } = JSON.parse(body) as { name: string };
				return reply(200, { id: 'agent-kasasi', name, mcpExposed: true, createdVia: 'mcp' });
			}
			if (req.method === 'POST' && req.url === '/api/mcp/imports') {
				const parsed = JSON.parse(body) as { vault?: string; path?: string };
				if (parsed.path === '/forbidden/file.pdf') {
					return reply(403, { message: 'MCP_PATH_NOT_ALLOWED', code: 'MCP_PATH_NOT_ALLOWED' });
				}
				if (parsed.vault === 'ghost') return reply(404, { message: 'NOT_FOUND', code: 'NOT_FOUND', params: { entity: 'vault' } });
				if (parsed.vault === 'closed') return reply(403, { message: 'MCP_VAULT_NOT_EXPOSED', code: 'MCP_VAULT_NOT_EXPOSED' });
				return reply(200, { vault: parsed.vault ?? 'default', importId: '11111111-1111-4111-8111-111111111111', status: 'queued' });
			}
			if (req.method === 'GET' && req.url?.startsWith('/api/mcp/imports')) {
				return reply(200, { vault: 'default', imports: [{ importId: '11111111-1111-4111-8111-111111111111', status: 'ready' }] });
			}
			return reply(404, { message: 'ROUTE_NOT_FOUND' });
		});
	});
	await new Promise<void>((resolve) => fakeApp.listen(0, '127.0.0.1', resolve));
	const fakePort = (fakeApp.address() as AddressInfo).port;
	try {
		writeMcpEndpoint(scratch, { url: `http://127.0.0.1:${fakePort}`, mcpToken: MCP_TOKEN, pid: process.pid, startedAt: now });

		const created = await client.callTool({ name: 'create_vault', arguments: { name: 'Gizli Kasa Adı' } });
		assert.equal(created.isError, undefined, text(created));
		assert.equal((JSON.parse(text(created)) as { vault: string }).vault, 'agent-kasasi', 'create_vault echoes the new vault id');

		const imported = await client.callTool({
			name: 'import_source',
			arguments: { vault: 'default', url: 'https://example.com/secret-article', domain: 'fizik' }
		});
		assert.equal(imported.isError, undefined, text(imported));
		const importedBody = JSON.parse(text(imported)) as { vault: string; importId: string; status: string };
		assert.equal(importedBody.vault, 'default');
		assert.equal(importedBody.status, 'queued');

		const pending = await client.callTool({ name: 'list_pending_imports', arguments: { vault: 'default' } });
		assert.equal(pending.isError, undefined, text(pending));
		const pendingBody = JSON.parse(text(pending)) as { vault: string; imports: { status: string }[] };
		assert.equal(pendingBody.vault, 'default');
		assert.equal(pendingBody.imports[0].status, 'ready');

		assert.deepEqual(
			seen.map((s) => `${s.method} ${s.url}`),
			['POST /api/mcp/vaults', 'POST /api/mcp/imports', 'GET /api/mcp/imports?vault=default']
		);
		for (const s of seen) {
			assert.equal(s.token, MCP_TOKEN, 'every request carries the MCP token from mcp-endpoint.json');
			assert.equal(s.origin, undefined, 'an MCP client must never send an Origin header');
		}
		assert.deepEqual(JSON.parse(seen[1].body), { vault: 'default', url: 'https://example.com/secret-article', domain: 'fizik' });
		console.log('ok - create_vault/import_source/list_pending_imports forward to the app with the token header and echo the vault id');

		// App-side coded errors surface as tool errors with the app's code (or the read tools' equivalent).
		const forbidden = await client.callTool({ name: 'import_source', arguments: { vault: 'default', path: '/forbidden/file.pdf' } });
		assert.equal(forbidden.isError, true);
		assert.ok(text(forbidden).startsWith('MCP_PATH_NOT_ALLOWED:'), text(forbidden));
		const ghost = await client.callTool({ name: 'import_source', arguments: { vault: 'ghost', url: 'https://example.com/a' } });
		assert.ok(text(ghost).startsWith('VAULT_NOT_FOUND:'), text(ghost));
		const closedVault = await client.callTool({ name: 'import_source', arguments: { vault: 'closed', url: 'https://example.com/a' } });
		assert.ok(text(closedVault).startsWith('VAULT_NOT_EXPOSED:'), text(closedVault));
		console.log('ok - app errors map to MCP_PATH_NOT_ALLOWED / VAULT_NOT_FOUND / VAULT_NOT_EXPOSED');

		// A rotated token (app restarted) is a 401 from the app -> APP_UNAUTHORIZED, never a thrown exception.
		writeMcpEndpoint(scratch, { url: `http://127.0.0.1:${fakePort}`, mcpToken: 'cd'.repeat(32), pid: process.pid, startedAt: now });
		const unauthorized = await client.callTool(writeCalls[0]);
		assert.equal(unauthorized.isError, true);
		assert.ok(text(unauthorized).startsWith('APP_UNAUTHORIZED:'), text(unauthorized));
		console.log('ok - a rejected token reports APP_UNAUTHORIZED');
	} finally {
		await new Promise<void>((resolve) => fakeApp.close(() => resolve()));
	}

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

	// Content rule for the write tools: kind/domain/nameChars only, never the URL, path or vault name.
	const rawLog = fs.readFileSync(logPath, 'utf-8');
	for (const secret of ['secret-article', '/forbidden/file.pdf', 'Gizli Kasa']) {
		assert.ok(!rawLog.includes(secret), `mcp-log.jsonl must not contain "${secret}"`);
	}
	const allLines = rawLog
		.trim()
		.split('\n')
		.map((l) => JSON.parse(l) as { tool: string; params: Record<string, unknown> });
	assert.deepEqual(allLines.find((l) => l.tool === 'import_source' && l.params.domain === 'fizik')?.params, { kind: 'url', domain: 'fizik' });
	assert.deepEqual(allLines.find((l) => l.tool === 'create_vault')?.params, { nameChars: 'Gizli Kasa Adı'.length });
	console.log('ok - write tools log metadata only (kind/domain/nameChars), never the path, URL or vault name');

	console.log('smoke test passed');
} finally {
	fs.rmSync(scratch, { recursive: true, force: true });
}
