import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMcpClientConfig } from './mcp-client-config';

const LAUNCH = 'C:\\repo\\mcp\\launch.mjs';
const NODE = 'C:\\node\\node.exe';
const DATA = 'C:\\Users\\a\\data';

test('no launch script (packaged app) -> unavailable, no snippet', () => {
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
