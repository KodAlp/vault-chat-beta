import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { secretStore, maskKey, JsonSecretStore, DpapiEncryptedSecretStore } from './secrets';

const TEST_KEY = Buffer.from('11'.repeat(32), 'hex');
const OTHER_KEY = Buffer.from('22'.repeat(32), 'hex');

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

/**
 * DpapiEncryptedSecretStore coverage — tested by constructing it directly
 * with a fixed key rather than through the `secretStore` singleton, since
 * that singleton is picked once at module-load time from whatever
 * SECRETS_KEY_HEX happened to be set then (see the class's own doc comment
 * on the module-level export). secretsPath() itself still re-reads
 * SECRETS_PATH on every call, so a fresh tmp file per test is enough
 * isolation here too.
 */
test('DpapiEncryptedSecretStore round-trips a key and stores it encrypted, not plain', async () => {
	const p = tmpSecretsPath();
	process.env.SECRETS_PATH = p;
	const store = new DpapiEncryptedSecretStore(TEST_KEY);
	await store.set('deepseek', 'sk-real-secret-value');
	assert.equal(await store.get('deepseek'), 'sk-real-secret-value');

	const onDisk = JSON.parse(fs.readFileSync(p, 'utf-8'));
	assert.equal(onDisk.encrypted, true);
	assert.equal(typeof onDisk.iv, 'string');
	assert.equal(typeof onDisk.tag, 'string');
	assert.equal(JSON.stringify(onDisk).includes('sk-real-secret-value'), false);

	await store.delete('deepseek');
	assert.equal(await store.get('deepseek'), null);
});

test('DpapiEncryptedSecretStore auto-migrates a legacy plaintext file on first read', async () => {
	const p = tmpSecretsPath();
	process.env.SECRETS_PATH = p;
	// Simulate the pre-encryption file this app has always written.
	await new JsonSecretStore().set('deepseek', 'sk-legacy-value');
	assert.equal(JSON.parse(fs.readFileSync(p, 'utf-8')).encrypted, undefined);

	const store = new DpapiEncryptedSecretStore(TEST_KEY);
	assert.equal(await store.get('deepseek'), 'sk-legacy-value');

	// The migration is a side effect of that first read — the file on disk
	// should now be the encrypted wrapper, not the original plaintext.
	const onDisk = JSON.parse(fs.readFileSync(p, 'utf-8'));
	assert.equal(onDisk.encrypted, true);
	assert.equal(JSON.stringify(onDisk).includes('sk-legacy-value'), false);

	// And a second store instance (a later launch, in effect) reads the
	// migrated value back correctly through the encrypted path.
	assert.equal(await new DpapiEncryptedSecretStore(TEST_KEY).get('deepseek'), 'sk-legacy-value');
});

test('DpapiEncryptedSecretStore degrades to empty on a wrong key instead of throwing', async () => {
	const p = tmpSecretsPath();
	process.env.SECRETS_PATH = p;
	await new DpapiEncryptedSecretStore(TEST_KEY).set('deepseek', 'sk-value');

	const wrongKeyStore = new DpapiEncryptedSecretStore(OTHER_KEY);
	assert.equal(await wrongKeyStore.get('deepseek'), null);
	assert.deepEqual(await wrongKeyStore.list(), []);
});

test('DpapiEncryptedSecretStore degrades to empty on a corrupt file instead of throwing', async () => {
	const p = tmpSecretsPath();
	process.env.SECRETS_PATH = p;
	fs.writeFileSync(p, JSON.stringify({ encrypted: true, iv: 'not-base64-!!', tag: 'nope', data: 'nope' }));
	const store = new DpapiEncryptedSecretStore(TEST_KEY);
	assert.equal(await store.get('deepseek'), null);
	assert.deepEqual(await store.list(), []);
});
