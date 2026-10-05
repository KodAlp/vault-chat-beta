import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeMcpEndpoint, readMcpEndpoint, removeMcpEndpoint, mcpEndpointPath } from './mcp-endpoint';

function tmp(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-endpoint-test-'));
}

const info = { url: 'http://127.0.0.1:5173', mcpToken: 'a'.repeat(64), pid: 4242, startedAt: '2026-10-05T10:00:00.000Z' };

test('write then read round-trips, and leaves no tmp file behind', () => {
	const dir = tmp();
	writeMcpEndpoint(dir, info);
	assert.deepEqual(readMcpEndpoint(dir), info);
	assert.deepEqual(fs.readdirSync(dir), ['mcp-endpoint.json']);
});

test('the file never contains a session token field', () => {
	const dir = tmp();
	writeMcpEndpoint(dir, info);
	const raw = JSON.parse(fs.readFileSync(mcpEndpointPath(dir), 'utf-8'));
	assert.deepEqual(Object.keys(raw).sort(), ['mcpToken', 'pid', 'startedAt', 'url']);
});

test('write replaces an existing file', () => {
	const dir = tmp();
	writeMcpEndpoint(dir, info);
	writeMcpEndpoint(dir, { ...info, pid: 7, mcpToken: 'b'.repeat(64) });
	assert.equal(readMcpEndpoint(dir)?.pid, 7);
});

test('missing, corrupt and wrongly-shaped files read as null', () => {
	const dir = tmp();
	assert.equal(readMcpEndpoint(dir), null);
	fs.writeFileSync(mcpEndpointPath(dir), '{nope');
	assert.equal(readMcpEndpoint(dir), null);
	fs.writeFileSync(mcpEndpointPath(dir), JSON.stringify({ url: 'x', mcpToken: '', pid: 1, startedAt: 'now' }));
	assert.equal(readMcpEndpoint(dir), null);
	fs.writeFileSync(mcpEndpointPath(dir), JSON.stringify({ url: 'x', mcpToken: 'y', pid: '1', startedAt: 'now' }));
	assert.equal(readMcpEndpoint(dir), null);
});

test('remove only deletes a file whose pid (and token, when given) still match', () => {
	const dir = tmp();
	writeMcpEndpoint(dir, info);
	assert.equal(removeMcpEndpoint(dir, 1), false, 'another pid must not delete it');
	assert.ok(fs.existsSync(mcpEndpointPath(dir)));
	assert.equal(removeMcpEndpoint(dir, info.pid, 'c'.repeat(64)), false, 'same pid, newer token must not delete it');
	assert.ok(fs.existsSync(mcpEndpointPath(dir)));
	assert.equal(removeMcpEndpoint(dir, info.pid, info.mcpToken), true);
	assert.ok(!fs.existsSync(mcpEndpointPath(dir)));
	assert.equal(removeMcpEndpoint(dir, info.pid), false, 'already gone is not an error');
});

test('on POSIX the file is owner-only', { skip: process.platform === 'win32' }, () => {
	const dir = tmp();
	writeMcpEndpoint(dir, info);
	assert.equal(fs.statSync(mcpEndpointPath(dir)).mode & 0o777, 0o600);
});
