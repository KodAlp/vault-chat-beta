import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
	readProvidersFile,
	updateEnabledModels,
	updateProviderDefaultModel,
	updatePinnedModels,
	updateProviderLocal,
	normalizeBaseUrl,
	addProvider,
	isCloud,
	type ProvidersFile
} from './config-store';
import { AppError } from '../app-error';

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

// normalizeBaseUrl — openai-compat.ts builds `${baseUrl}/chat/completions`,
// so a trailing slash (or several) left on a saved baseUrl produces a
// double-slash path that 404s on most OpenAI-compatible APIs.
test('normalizeBaseUrl strips a single trailing slash', () => {
	assert.equal(normalizeBaseUrl('https://api.example.com/v1/'), 'https://api.example.com/v1');
});

test('normalizeBaseUrl strips several trailing slashes', () => {
	assert.equal(normalizeBaseUrl('https://api.example.com/v1///'), 'https://api.example.com/v1');
});

test('normalizeBaseUrl trims surrounding whitespace', () => {
	assert.equal(normalizeBaseUrl('  https://api.example.com/v1  '), 'https://api.example.com/v1');
});

test('normalizeBaseUrl leaves an already-clean URL unchanged', () => {
	assert.equal(normalizeBaseUrl('https://api.example.com/v1'), 'https://api.example.com/v1');
});

test('normalizeBaseUrl throws PROVIDER_BASE_URL_INVALID when the scheme is missing', () => {
	assert.throws(() => normalizeBaseUrl('api.example.com/v1'), (err: unknown) => {
		assert.ok(err instanceof AppError);
		assert.equal(err.code, 'PROVIDER_BASE_URL_INVALID');
		return true;
	});
});

test('addProvider normalizes baseUrl (strips the trailing slash) before saving', () => {
	useTmpProvidersFile();
	const entry = addProvider({ label: 'Test Provider', baseUrl: 'https://api.test.com/v1/', kind: 'openai-compat', reasoningDialect: 'none' });
	assert.equal(entry.baseUrl, 'https://api.test.com/v1');
	assert.equal(readProvidersFile().providers.find((p) => p.id === entry.id)?.baseUrl, 'https://api.test.com/v1');
});

test('addProvider rejects a baseUrl with no http(s) scheme', () => {
	useTmpProvidersFile();
	assert.throws(() => addProvider({ label: 'Bad', baseUrl: 'ftp://api.test.com', kind: 'openai-compat', reasoningDialect: 'none' }));
});

// Problem A — isCloud(entry)

test('isCloud: ollama is never cloud', () => {
	assert.equal(isCloud({ kind: 'ollama' }), false);
});

test('isCloud: a plain openai-compat provider is cloud', () => {
	assert.equal(isCloud({ kind: 'openai-compat' }), true);
});

test('isCloud: an openai-compat provider marked local is not cloud', () => {
	assert.equal(isCloud({ kind: 'openai-compat', local: true }), false);
});

test('isCloud: anthropic is always cloud, even if local were somehow set', () => {
	assert.equal(isCloud({ kind: 'anthropic' }), true);
});

test('isCloud: azure-openai is always cloud', () => {
	assert.equal(isCloud({ kind: 'azure-openai' }), true);
});

// Problem A — addProvider's local timeouts

test('addProvider without local uses the standard cloud timeouts', () => {
	useTmpProvidersFile();
	const entry = addProvider({ label: 'Cloud One', baseUrl: 'https://api.example.com/v1', kind: 'openai-compat', reasoningDialect: 'none' });
	assert.deepEqual(entry.timeouts, { connectMs: 5000, firstTokenMs: 30000, idleMs: 30000 });
	assert.equal(entry.local, undefined);
});

test('addProvider with local:true gets ollama-like generous timeouts and local:true is persisted', () => {
	useTmpProvidersFile();
	const entry = addProvider({ label: 'LM Studio', baseUrl: 'http://127.0.0.1:1234/v1', kind: 'openai-compat', reasoningDialect: 'none', local: true });
	assert.deepEqual(entry.timeouts, { connectMs: 30000, firstTokenMs: 300000, idleMs: 60000 });
	assert.equal(entry.local, true);
	assert.equal(readProvidersFile().providers.find((p) => p.id === entry.id)?.local, true);
});

test('addProvider ignores local:true for a non-openai-compat kind', () => {
	useTmpProvidersFile();
	const entry = addProvider({ label: 'Claude', baseUrl: 'https://api.anthropic.com/v1', kind: 'anthropic', reasoningDialect: 'none', local: true });
	assert.equal(entry.local, undefined);
	assert.deepEqual(entry.timeouts, { connectMs: 5000, firstTokenMs: 30000, idleMs: 30000 });
});

// Problem A — updateProviderLocal

test('updateProviderLocal sets and clears local on an openai-compat provider', () => {
	useTmpProvidersFile();
	updateProviderLocal('groq', true);
	assert.equal(readProvidersFile().providers[0].local, true);
	updateProviderLocal('groq', false);
	assert.equal(readProvidersFile().providers[0].local, undefined);
});

test('updateProviderLocal is a no-op on a non-openai-compat provider', () => {
	const data: ProvidersFile = {
		providers: [{ id: 'claude', label: 'Claude', baseUrl: 'https://api.anthropic.com/v1', kind: 'anthropic', reasoningDialect: 'none', enabled: true, timeouts: { connectMs: 5000, firstTokenMs: 30000, idleMs: 30000 } }],
		chains: {}
	};
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-store-test-'));
	const p = path.join(dir, 'providers.json');
	fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n', 'utf-8');
	process.env.PROVIDERS_PATH = p;
	updateProviderLocal('claude', true);
	assert.equal(readProvidersFile().providers[0].local, undefined);
});

test('updateProviderLocal on an unknown provider id throws', () => {
	useTmpProvidersFile();
	assert.throws(() => updateProviderLocal('no-such-provider', true));
});

// Problem B — updatePinnedModels validation

test('updatePinnedModels sets the pinned list and it round-trips through a fresh read', () => {
	useTmpProvidersFile();
	updatePinnedModels('groq', ['deployment-a', 'deployment-b']);
	assert.deepEqual(readProvidersFile().providers[0].pinnedModels, ['deployment-a', 'deployment-b']);
});

test('updatePinnedModels(id, null) clears the field', () => {
	useTmpProvidersFile();
	updatePinnedModels('groq', ['deployment-a']);
	updatePinnedModels('groq', null);
	assert.equal('pinnedModels' in readProvidersFile().providers[0], false);
});

test('updatePinnedModels trims whitespace, drops empty/whitespace-only entries, and dedupes preserving first-seen order', () => {
	useTmpProvidersFile();
	updatePinnedModels('groq', ['  model-a  ', '', '   ', 'model-b', 'model-a']);
	assert.deepEqual(readProvidersFile().providers[0].pinnedModels, ['model-a', 'model-b']);
});

test('updatePinnedModels drops an entry longer than 200 characters', () => {
	useTmpProvidersFile();
	const tooLong = 'x'.repeat(201);
	updatePinnedModels('groq', [tooLong, 'ok-id']);
	assert.deepEqual(readProvidersFile().providers[0].pinnedModels, ['ok-id']);
});

test('updatePinnedModels with an empty array is stored as an empty array, not deleted', () => {
	useTmpProvidersFile();
	updatePinnedModels('groq', []);
	const data = readProvidersFile();
	assert.deepEqual(data.providers[0].pinnedModels, []);
	assert.ok('pinnedModels' in data.providers[0]);
});

test('updatePinnedModels on an unknown provider id throws', () => {
	useTmpProvidersFile();
	assert.throws(() => updatePinnedModels('no-such-provider', ['x']));
});
