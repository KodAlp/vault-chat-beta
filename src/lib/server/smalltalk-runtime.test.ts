
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkSmallTalk, teachSmallTalk, afterSmallTalkGate } from './smalltalk-runtime';
import { setEmbeddingConfig, type ProvidersFile } from './providers/config-store';

// Aşama 4a — FTS-only mode (embedding null): every entry point of the small-talk glue must be a quiet no-op.
function useFtsOnlyConfig(): void {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smalltalk-runtime-test-'));
	const data: ProvidersFile = { providers: [], chains: {} };
	fs.writeFileSync(path.join(dir, 'providers.json'), JSON.stringify(data), 'utf-8');
	process.env.PROVIDERS_PATH = path.join(dir, 'providers.json');
	process.env.PROVIDER_CONSENT_PATH = path.join(dir, 'provider-consent.json');
	setEmbeddingConfig(null);
}

test('checkSmallTalk returns no decision (no throw) in FTS-only mode', () => {
	useFtsOnlyConfig();
	assert.equal(checkSmallTalk([1, 0, 0], 0.1), null);
});

test('teachSmallTalk stores nothing and does not throw in FTS-only mode', async () => {
	useFtsOnlyConfig();
	assert.equal(await teachSmallTalk('selam nasilsin'), false);
});

test('afterSmallTalkGate is a no-op in FTS-only mode', () => {
	useFtsOnlyConfig();
	assert.doesNotThrow(() => afterSmallTalkGate({ sim: 0.9, overridden: true }, 'selam'));
});
