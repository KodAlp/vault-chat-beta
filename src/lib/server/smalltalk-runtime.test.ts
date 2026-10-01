
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkSmallTalk, teachSmallTalk, afterSmallTalkGate, learnFromMessage, smallTalkGateActive } from './smalltalk-runtime';
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

// The thresholds were measured with bge-m3 only: any other embedding model switches the gate off.
function useEmbeddingConfig(model: string, dims: number): void {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smalltalk-runtime-test-'));
	const data = { providers: [], chains: {}, embedding: { providerId: 'ollama', model, dims } };
	fs.writeFileSync(path.join(dir, 'providers.json'), JSON.stringify(data), 'utf-8');
	process.env.PROVIDERS_PATH = path.join(dir, 'providers.json');
	process.env.PROVIDER_CONSENT_PATH = path.join(dir, 'provider-consent.json');
}

test('gate is inactive and all entry points are no-ops for a non-bge-m3 embedding model', async () => {
	useEmbeddingConfig('nomic-embed-text', 768);
	assert.equal(smallTalkGateActive(), false);
	assert.equal(checkSmallTalk([1, 0, 0], 0.1), null);
	assert.equal(await learnFromMessage('selam', 'user'), null);
	assert.equal(await teachSmallTalk('selam nasilsin'), false);
	assert.doesNotThrow(() => afterSmallTalkGate({ sim: 0.9, overridden: true }, 'selam'));
});

test('gate is inactive for bge-m3 spelled with the wrong dims, active with the right ones', () => {
	useEmbeddingConfig('bge-m3', 768);
	assert.equal(smallTalkGateActive(), false);
	useEmbeddingConfig('BAAI/bge-m3', 1024);
	assert.equal(smallTalkGateActive(), true);
});
