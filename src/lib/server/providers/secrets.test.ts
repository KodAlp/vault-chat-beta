import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { secretStore, maskKey } from './secrets';

/**
 * Regression coverage for Part 4B of the model-routing/security cleanup —
 * secrets.ts's own doc comment already states the contract ("Keys never
 * reach the client — no endpoint in this layer returns a raw value, callers
 * that need to show status use maskKey() instead"); this file is what
 * actually pins that down so a future change can't silently regress it.
 * secretsPath() re-reads process.env.SECRETS_PATH on every call (env.ts's
 * "every accessor is a function" rule), so pointing it at a fresh tmp file
 * per test is enough isolation — no module reset needed.
 */
function tmpSecretsPath(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secrets-test-'));
	return path.join(dir, 'secrets.json');
}

test('set/get/delete round-trips a key through the JSON store', async () => {
	process.env.SECRETS_PATH = tmpSecretsPath();
	await secretStore.set('deepseek', 'sk-real-secret-value');
	assert.equal(await secretStore.get('deepseek'), 'sk-real-secret-value');
	await secretStore.delete('deepseek');
	assert.equal(await secretStore.get('deepseek'), null);
});

test('get returns null for a provider that was never given a key', async () => {
	process.env.SECRETS_PATH = tmpSecretsPath();
	assert.equal(await secretStore.get('never-connected'), null);
});

test('list() returns provider ids only — never the stored key values', async () => {
	process.env.SECRETS_PATH = tmpSecretsPath();
	await secretStore.set('deepseek', 'sk-one-secret');
	await secretStore.set('openai', 'sk-another-secret');
	const ids = await secretStore.list();
	assert.deepEqual(ids.sort(), ['deepseek', 'openai']);
	assert.equal(ids.some((id) => id.includes('sk-')), false);
});

test('maskKey never contains the full raw key, only a short prefix/suffix', () => {
	const raw = 'sk-abcdefghijklmnopqrstuvwxyz0123456789';
	const masked = maskKey(raw);
	assert.notEqual(masked, raw);
	assert.equal(masked.includes(raw), false);
	// First 3 + last 4 chars, per maskKey's own doc comment.
	assert.equal(masked, 'sk-…6789');
});

test('maskKey collapses a very short key to an ellipsis, not a near-full echo', () => {
	assert.equal(maskKey('short'), '…');
});

test('the on-disk secrets file is created with owner-only permissions where the OS supports it', async () => {
	if (process.platform === 'win32') return; // POSIX mode bits are a no-op on Windows — see secrets.ts's writeAll comment
	const p = tmpSecretsPath();
	process.env.SECRETS_PATH = p;
	await secretStore.set('deepseek', 'sk-value');
	const mode = fs.statSync(p).mode & 0o777;
	assert.equal(mode, 0o600);
});
