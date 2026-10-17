import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { buildMcpClientConfig, locateLaunchScript } from './mcp-client-config';

const LAUNCH = 'C:\\repo\\mcp\\launch.mjs';
const NODE = 'C:\\node\\node.exe';
const DATA = 'C:\\Users\\a\\data';

test('no launch script found -> unavailable, no snippet', () => {
	assert.deepEqual(buildMcpClientConfig(null, '/usr/bin/node', '/data'), { available: false });
});

test('snippet carries absolute paths and DATA_DIR, parses as JSON, has no token', () => {
	const c = buildMcpClientConfig(LAUNCH, NODE, DATA);
	assert.ok(c.available);
	const parsed = JSON.parse(c.json);
	assert.equal(parsed.mcpServers['vault-chat'].command, NODE);
	assert.deepEqual(parsed.mcpServers['vault-chat'].args, [LAUNCH]);
	assert.equal(parsed.mcpServers['vault-chat'].env.DATA_DIR, DATA);
	assert.ok(!/token/i.test(c.json));
	assert.equal(c.claudeCodeCommand, `claude mcp add --scope user -e DATA_DIR="${DATA}" vault-chat -- "${NODE}" "${LAUNCH}"`);
});

test('locateLaunchScript finds the packaged bundle from a chunk deep inside dist-server/build', () => {
	const bundle = path.resolve('/app/dist-server/mcp/vault-chat-mcp.mjs');
	const found = locateLaunchScript([path.resolve('/elsewhere'), path.resolve('/app/dist-server/build/server/chunks')], (p) => p === bundle);
	assert.equal(found, bundle);
});

test('locateLaunchScript finds a checkout launch.mjs, and the nearest level wins over a farther bundle', () => {
	const launch = path.resolve('/repo/mcp/launch.mjs');
	assert.equal(locateLaunchScript([path.resolve('/repo/src/lib/server')], (p) => p === launch), launch);
	const bundle = path.resolve('/repo/dist-server/mcp/vault-chat-mcp.mjs');
	assert.equal(locateLaunchScript([path.resolve('/repo/dist-server/build/server')], (p) => p === bundle || p === launch), bundle);
});

test('locateLaunchScript returns null when nothing is found and does not climb forever', () => {
	assert.equal(locateLaunchScript([path.resolve('/a/b/c')], () => false), null);
});
