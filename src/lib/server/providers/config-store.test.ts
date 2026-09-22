import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readProvidersFile, updateEnabledModels, updateProviderDefaultModel, type ProvidersFile } from './config-store';

const BASE: ProvidersFile = {
	providers: [{ id: 'groq', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', kind: 'openai-compat', reasoningDialect: 'none', enabled: true, timeouts: { connectMs: 5000, firstTokenMs: 30000, idleMs: 30000 } }],
	chains: { chat: ['groq'] }
};

function useTmpProvidersFile(): void {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-store-test-'));
	const p = path.join(dir, 'providers.json');
	fs.writeFileSync(p, JSON.stringify(BASE, null, 2) + '\n', 'utf-8');
	process.env.PROVIDERS_PATH = p;
}

test('updateEnabledModels sets the allow-list and it round-trips through a fresh read', () => {
	useTmpProvidersFile();
	updateEnabledModels('groq', ['model-a', 'model-b']);
	const data = readProvidersFile();
	assert.deepEqual(data.providers[0].enabledModels, ['model-a', 'model-b']);
});

test('updateEnabledModels with an empty array is stored as an empty array, not deleted', () => {
	useTmpProvidersFile();
	updateEnabledModels('groq', []);
	const data = readProvidersFile();
	assert.deepEqual(data.providers[0].enabledModels, []);
	assert.ok('enabledModels' in data.providers[0], 'the key itself is present, distinguishing "chose none" from "never curated"');
});

test('updateEnabledModels(id, null) clears the field back to uncurated', () => {
	useTmpProvidersFile();
	updateEnabledModels('groq', ['model-a']);
	updateEnabledModels('groq', null);
	const data = readProvidersFile();
	assert.equal('enabledModels' in data.providers[0], false);
});

test('updateEnabledModels on an unknown provider id throws', () => {
	useTmpProvidersFile();
	assert.throws(() => updateEnabledModels('no-such-provider', ['x']));
});

test('the file on disk survives a write intact (atomic tmp+rename leaves no stray .tmp file)', () => {
	useTmpProvidersFile();
	updateProviderDefaultModel('groq', 'llama-3.1-8b');
	const dir = path.dirname(process.env.PROVIDERS_PATH!);
	const leftoverTmp = fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'));
	assert.deepEqual(leftoverTmp, []);
	assert.equal(readProvidersFile().providers[0].defaultModel, 'llama-3.1-8b');
});
