import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideMcpGate, isMcpApiPath } from './mcp-gate';

const TOKEN = 'a'.repeat(64);
const base = { pathname: '/api/mcp/ping', token: TOKEN as string | undefined, headerToken: TOKEN as string | null, origin: null as string | null };

test('only /api/mcp and below counts as the MCP area', () => {
	assert.equal(isMcpApiPath('/api/mcp/ping'), true);
	assert.equal(isMcpApiPath('/api/mcp/imports'), true);
	assert.equal(isMcpApiPath('/api/mcp'), true);
	assert.equal(isMcpApiPath('/api/mcpx'), false);
	assert.equal(isMcpApiPath('/api/settings/mcp'), false, 'the settings route is session-gated, not MCP-reachable');
	assert.equal(isMcpApiPath('/api/vaults'), false);
	assert.equal(isMcpApiPath('/api/import/mcp/'), false);
});

test('other paths are not decided here, even with a valid MCP token', () => {
	assert.deepEqual(decideMcpGate({ ...base, pathname: '/api/vaults' }), { kind: 'not-mcp' });
	assert.deepEqual(decideMcpGate({ ...base, pathname: '/api/settings/mcp' }), { kind: 'not-mcp' });
});

test('a matching token and no Origin is allowed', () => {
	assert.deepEqual(decideMcpGate(base), { kind: 'allow' });
});

test('no token configured disables the whole area with 503', () => {
	assert.deepEqual(decideMcpGate({ ...base, token: undefined }), { kind: 'reject', status: 503, code: 'MCP_API_DISABLED' });
	assert.deepEqual(decideMcpGate({ ...base, token: '' }), { kind: 'reject', status: 503, code: 'MCP_API_DISABLED' });
});

test('missing, wrong, empty and wrong-length tokens are 401', () => {
	for (const headerToken of [null, '', 'b'.repeat(64), 'a'.repeat(63), TOKEN + 'x']) {
		assert.deepEqual(decideMcpGate({ ...base, headerToken }), { kind: 'reject', status: 401, code: 'MCP_TOKEN_REQUIRED' });
	}
});

test('any Origin header is refused with 403, even with a valid token', () => {
	assert.deepEqual(decideMcpGate({ ...base, origin: 'http://127.0.0.1:5173' }), {
		kind: 'reject',
		status: 403,
		code: 'CROSS_SITE_BLOCKED'
	});
	assert.equal(decideMcpGate({ ...base, origin: 'null' }).kind, 'reject');
	assert.equal(decideMcpGate({ ...base, origin: '' }).kind, 'reject');
});
