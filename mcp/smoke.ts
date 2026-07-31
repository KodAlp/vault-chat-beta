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
 * Never touches the real vault — seeds an isolated scratch DATA_DIR with
 * a single hand-written vault entry (no index.db needed: list_vaults'
 * summary queries all degrade to zero/[] for an unindexed vault, per
 * retrieve.ts's getDb() null-return contract).
 */
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-chat-mcp-smoke-'));
process.env.DATA_DIR = scratch;

const now = new Date().toISOString();
fs.writeFileSync(
	path.join(scratch, 'vaults.json'),
	JSON.stringify({
		vaults: [{ id: 'default', name: 'Smoke Test', path: 'default', createdAt: now, lastOpenedAt: now }],
		activeVaultId: 'default'
	})
);

try {
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const server = createServer();
	const client = new Client({ name: 'smoke-test', version: '0.0.0' });

	await server.connect(serverTransport);
	await client.connect(clientTransport);

	const { tools } = await client.listTools();
	assert.equal(tools.length, 1, `expected 1 registered tool, got ${tools.length}`);
	assert.equal(tools[0].name, 'list_vaults');
	assert.equal(tools[0].annotations?.readOnlyHint, true, 'list_vaults must be marked readOnlyHint');
	assert.equal(tools[0].annotations?.destructiveHint, false);
	console.log('ok - tools/list returns list_vaults with readOnlyHint');

	const result = await client.callTool({ name: 'list_vaults', arguments: {} });
	assert.equal(result.isError, undefined, 'list_vaults should not return an error');
	const content = result.content as { type: string; text: string }[];
	const parsed = JSON.parse(content[0].text) as {
		vaults: { id: string; active: boolean; indexed: boolean; noteCount: number }[];
	};
	assert.equal(parsed.vaults.length, 1);
	assert.equal(parsed.vaults[0].id, 'default');
	assert.equal(parsed.vaults[0].active, true, 'the only vault falls back to active via getActiveVaultId()');
	assert.equal(parsed.vaults[0].indexed, false, 'never-indexed vault must not throw or report indexed:true');
	assert.equal(parsed.vaults[0].noteCount, 0);
	console.log('ok - list_vaults returns the seeded vault, correctly reporting it as unindexed');

	const logPath = path.join(scratch, 'mcp-log.jsonl');
	assert.ok(fs.existsSync(logPath), 'mcp-log.jsonl should exist after a tool call');
	const logLine = JSON.parse(fs.readFileSync(logPath, 'utf-8').trim().split('\n')[0]) as { tool: string; ok: boolean };
	assert.equal(logLine.tool, 'list_vaults');
	assert.equal(logLine.ok, true);
	console.log('ok - mcp-log.jsonl recorded the call');

	console.log('smoke test passed');
} finally {
	fs.rmSync(scratch, { recursive: true, force: true });
}
