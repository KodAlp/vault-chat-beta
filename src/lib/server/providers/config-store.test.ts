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
	deleteProvider,
	updateProviderEnabled,
	updateChain,
	updateModelCaps,
	getOllamaBaseUrl,
	getOllamaProviderId,
	isCloud,
	getEmbeddingConfig,
	setEmbeddingConfig,
	type ProvidersFile
} from './config-store';
import { AppError } from '../app-error';
import { grantProviderConsent } from '../provider-consent';
import { EMBED_MODEL, EMBED_DIMS } from '../embed-config';

const BASE: ProvidersFile = {
	providers: [
		{ id: 'groq', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', kind: 'openai-compat', reasoningDialect: 'none', enabled: true, timeouts: { connectMs: 5000, firstTokenMs: 30000, idleMs: 30000 } },
		{ id: 'ollama', label: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1', kind: 'ollama', reasoningDialect: 'think-tags', enabled: true, timeouts: { connectMs: 5000, firstTokenMs: 120000, idleMs: 30000 } },
		{ id: 'claude', label: 'Claude', baseUrl: 'https://api.anthropic.com/v1', kind: 'anthropic', reasoningDialect: 'none', enabled: true, timeouts: { connectMs: 5000, firstTokenMs: 30000, idleMs: 30000 } },
		{ id: 'disabled-compat', label: 'Disabled', baseUrl: 'https://api.example.com/v1', kind: 'openai-compat', reasoningDialect: 'none', enabled: false, timeouts: { connectMs: 5000, firstTokenMs: 30000, idleMs: 30000 } },
		{ id: 'local-compat', label: 'LM Studio', baseUrl: 'http://127.0.0.1:1234/v1', kind: 'openai-compat', reasoningDialect: 'none', enabled: true, local: true, timeouts: { connectMs: 30000, firstTokenMs: 300000, idleMs: 60000 } }
	],
	chains: { chat: ['groq'] }
};

function useTmpProvidersFile(): void {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-store-test-'));
	const p = path.join(dir, 'providers.json');
	fs.writeFileSync(p, JSON.stringify(BASE, null, 2) + '\n', 'utf-8');
	process.env.PROVIDERS_PATH = p;
	// Embedding tests grant/check consent (provider-consent.ts) — a fresh
	// path per test so one test's grant never leaks into the next.
	process.env.PROVIDER_CONSENT_PATH = path.join(dir, 'provider-consent.json');
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

// Aşama 3a — getEmbeddingConfig()/setEmbeddingConfig()

test('getEmbeddingConfig defaults to ollama/bge-m3/EMBED_DIMS when providers.json has no embedding block', () => {
	useTmpProvidersFile();
	assert.deepEqual(getEmbeddingConfig(), { providerId: 'ollama', model: EMBED_MODEL, dims: EMBED_DIMS });
});

test('setEmbeddingConfig saves a valid config and getEmbeddingConfig reads it back', () => {
	useTmpProvidersFile();
	setEmbeddingConfig({ providerId: 'ollama', model: 'bge-m3', dims: 1024 });
	assert.deepEqual(getEmbeddingConfig(), { providerId: 'ollama', model: 'bge-m3', dims: 1024 });
});

test('setEmbeddingConfig stores an explicit distanceThreshold', () => {
	useTmpProvidersFile();
	setEmbeddingConfig({ providerId: 'ollama', model: 'bge-m3', dims: 1024, distanceThreshold: 0.5 });
	assert.equal(getEmbeddingConfig()?.distanceThreshold, 0.5);
});

test('setEmbeddingConfig on a local openai-compat provider needs no consent', () => {
	useTmpProvidersFile();
	assert.doesNotThrow(() => setEmbeddingConfig({ providerId: 'local-compat', model: 'a-model', dims: 768 }));
});

test('setEmbeddingConfig on an unknown provider id throws NOT_FOUND', () => {
	useTmpProvidersFile();
	assert.throws(() => setEmbeddingConfig({ providerId: 'no-such-provider', model: 'x', dims: 8 }), (err: unknown) => {
		assert.ok(err instanceof AppError);
		assert.equal(err.code, 'NOT_FOUND');
		return true;
	});
});

test('setEmbeddingConfig on a disabled provider throws EMBEDDING_PROVIDER_DISABLED', () => {
	useTmpProvidersFile();
	assert.throws(() => setEmbeddingConfig({ providerId: 'disabled-compat', model: 'x', dims: 8 }), (err: unknown) => {
		assert.ok(err instanceof AppError);
		assert.equal(err.code, 'EMBEDDING_PROVIDER_DISABLED');
		return true;
	});
});

test('setEmbeddingConfig on a kind with no embeddings adapter throws EMBEDDING_PROVIDER_KIND_UNSUPPORTED', () => {
	useTmpProvidersFile();
	assert.throws(() => setEmbeddingConfig({ providerId: 'claude', model: 'x', dims: 8 }), (err: unknown) => {
		assert.ok(err instanceof AppError);
		assert.equal(err.code, 'EMBEDDING_PROVIDER_KIND_UNSUPPORTED');
		return true;
	});
});

test('setEmbeddingConfig rejects a non-positive-integer dims', () => {
	useTmpProvidersFile();
	for (const bad of [0, -1, 1.5]) {
		assert.throws(() => setEmbeddingConfig({ providerId: 'ollama', model: 'x', dims: bad }), (err: unknown) => {
			assert.ok(err instanceof AppError);
			assert.equal(err.code, 'EMBEDDING_DIMS_INVALID');
			return true;
		});
	}
});

test('setEmbeddingConfig rejects a non-positive distanceThreshold', () => {
	useTmpProvidersFile();
	assert.throws(() => setEmbeddingConfig({ providerId: 'ollama', model: 'x', dims: 8, distanceThreshold: 0 }), (err: unknown) => {
		assert.ok(err instanceof AppError);
		assert.equal(err.code, 'VALIDATION_INVALID');
		return true;
	});
});

test('setEmbeddingConfig on a cloud provider with no consent throws EMBEDDING_CONSENT_REQUIRED', () => {
	useTmpProvidersFile();
	// groq is openai-compat with no `local: true` — isCloud() says it needs consent.
	assert.throws(() => setEmbeddingConfig({ providerId: 'groq', model: 'a-model', dims: 768, distanceThreshold: undefined }), (err: unknown) => {
		assert.ok(err instanceof AppError);
		assert.equal(err.code, 'EMBEDDING_CONSENT_REQUIRED');
		return true;
	});
});

test('setEmbeddingConfig on a cloud provider succeeds once consent is granted', () => {
	useTmpProvidersFile();
	grantProviderConsent('groq');
	assert.doesNotThrow(() => setEmbeddingConfig({ providerId: 'groq', model: 'a-model', dims: 768 }));
	assert.equal(getEmbeddingConfig()?.providerId, 'groq');
});

// Aşama 4a — Ollama is an ordinary provider now: no disable/delete guards, and embedding can be absent (FTS-only).
function writeProviders(data: ProvidersFile): void {
	fs.writeFileSync(process.env.PROVIDERS_PATH!, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

test('Ollama can be disabled (no PROVIDER_OLLAMA_REQUIRED guard any more)', () => {
	useTmpProvidersFile();
	assert.doesNotThrow(() => updateProviderEnabled('ollama', false));
	assert.equal(readProvidersFile().providers.find((p) => p.id === 'ollama')?.enabled, false);
});

test('Ollama can be deleted (no PROVIDER_OLLAMA_UNDELETABLE guard any more) and leaves every chain', () => {
	useTmpProvidersFile();
	updateChain('chat', ['groq', 'ollama']);
	updateChain('title', ['ollama']);
	assert.doesNotThrow(() => deleteProvider('ollama'));
	const data = readProvidersFile();
	assert.equal(data.providers.some((p) => p.id === 'ollama'), false);
	assert.deepEqual(data.chains.chat, ['groq']);
	assert.deepEqual(data.chains.title, []);
});

test('deleting the implicit-default embedding provider (ollama, no embedding block) switches to FTS-only', () => {
	useTmpProvidersFile();
	assert.equal(getEmbeddingConfig()?.providerId, 'ollama');
	deleteProvider('ollama');
	assert.equal(getEmbeddingConfig(), null);
});

test('deleting the explicitly configured embedding provider sets embedding to null, not back to the ollama default', () => {
	useTmpProvidersFile();
	setEmbeddingConfig({ providerId: 'local-compat', model: 'a-model', dims: 768 });
	deleteProvider('local-compat');
	const data = readProvidersFile();
	assert.equal(data.embedding, null);
	assert.equal(getEmbeddingConfig(), null, 'an ollama entry still exists, but the explicit null wins over the legacy default');
});

test('deleting an unrelated provider leaves the embedding config alone', () => {
	useTmpProvidersFile();
	setEmbeddingConfig({ providerId: 'local-compat', model: 'a-model', dims: 768 });
	deleteProvider('groq');
	assert.equal(getEmbeddingConfig()?.providerId, 'local-compat');
});

test('getEmbeddingConfig is null when providers.json has no embedding block and no ollama entry', () => {
	useTmpProvidersFile();
	writeProviders({ ...BASE, providers: BASE.providers.filter((p) => p.id !== 'ollama') });
	assert.equal(getEmbeddingConfig(), null);
});

test('an explicit embedding: null stays null even though an ollama entry exists', () => {
	useTmpProvidersFile();
	writeProviders({ ...BASE, embedding: null });
	assert.equal(getEmbeddingConfig(), null);
});

test('setEmbeddingConfig(null) stores explicit FTS-only mode and a later real config replaces it', () => {
	useTmpProvidersFile();
	setEmbeddingConfig(null);
	assert.equal(getEmbeddingConfig(), null);
	assert.equal(readProvidersFile().embedding, null);
	setEmbeddingConfig({ providerId: 'ollama', model: 'bge-m3', dims: 1024 });
	assert.equal(getEmbeddingConfig()?.providerId, 'ollama');
});

test('getOllamaBaseUrl reads the ollama entry baseUrl (trailing slash stripped) and defaults when there is none', () => {
	useTmpProvidersFile();
	const withCustom: ProvidersFile = {
		...BASE,
		providers: BASE.providers.map((p) => (p.id === 'ollama' ? { ...p, baseUrl: 'http://192.168.1.5:11434/' } : p))
	};
	writeProviders(withCustom);
	assert.equal(getOllamaBaseUrl(), 'http://192.168.1.5:11434');
	writeProviders({ ...BASE, providers: BASE.providers.filter((p) => p.kind !== 'ollama') });
	assert.equal(getOllamaBaseUrl(), 'http://127.0.0.1:11434');
});

// Aşama 4b — modelCaps override setter.
test('updateModelCaps stores an override and it round-trips through a fresh read', () => {
	useTmpProvidersFile();
	updateModelCaps('local-compat', 'qwen/qwen3-8b', { tools: false, reasoning: true });
	assert.deepEqual(readProvidersFile().providers.find((p) => p.id === 'local-compat')?.modelCaps, { 'qwen/qwen3-8b': { tools: false, reasoning: true } });
});

test('updateModelCaps merges per model, keeps only boolean flags, and replaces a model\'s earlier override', () => {
	useTmpProvidersFile();
	updateModelCaps('local-compat', 'a', { tools: true });
	updateModelCaps('local-compat', 'b', { reasoning: true });
	updateModelCaps('local-compat', 'a', { reasoning: false, tools: 'yes' as unknown as boolean });
	assert.deepEqual(readProvidersFile().providers.find((p) => p.id === 'local-compat')?.modelCaps, { a: { reasoning: false }, b: { reasoning: true } });
});

test('updateModelCaps(null) / an empty override clears the model, and an emptied map is removed from the entry', () => {
	useTmpProvidersFile();
	updateModelCaps('local-compat', 'a', { tools: true });
	updateModelCaps('local-compat', 'a', null);
	assert.equal('modelCaps' in readProvidersFile().providers.find((p) => p.id === 'local-compat')!, false);
	updateModelCaps('local-compat', 'a', { tools: true });
	updateModelCaps('local-compat', 'a', {});
	assert.equal('modelCaps' in readProvidersFile().providers.find((p) => p.id === 'local-compat')!, false);
});

test('updateModelCaps rejects an unknown provider and an empty or oversized model id; other writers keep modelCaps intact', () => {
	useTmpProvidersFile();
	assert.throws(() => updateModelCaps('nope', 'a', { tools: true }));
	assert.throws(() => updateModelCaps('local-compat', '  ', { tools: true }));
	assert.throws(() => updateModelCaps('local-compat', 'x'.repeat(201), { tools: true }));
	updateModelCaps('local-compat', 'a', { tools: true });
	updateProviderDefaultModel('local-compat', 'a');
	assert.deepEqual(readProvidersFile().providers.find((p) => p.id === 'local-compat')?.modelCaps, { a: { tools: true } });
});

// Aşama 4c — updateChain validation, and the shipped default config.
test('updateChain rejects an unknown provider id, a duplicate, a non-string id and an empty task type', () => {
	useTmpProvidersFile();
	assert.throws(() => updateChain('chat', ['groq', 'no-such']), (err: unknown) => err instanceof AppError && err.code === 'NOT_FOUND');
	assert.throws(() => updateChain('chat', ['groq', 'groq']), (err: unknown) => err instanceof AppError && err.code === 'VALIDATION_INVALID');
	assert.throws(() => updateChain('chat', [1 as unknown as string]), (err: unknown) => err instanceof AppError && err.code === 'VALIDATION_INVALID');
	assert.throws(() => updateChain('  ', ['groq']), (err: unknown) => err instanceof AppError && err.code === 'VALIDATION_INVALID');
	assert.deepEqual(readProvidersFile().chains.chat, ['groq'], 'a rejected write leaves the chain untouched');
});

test('updateChain accepts an empty chain and valid ids', () => {
	useTmpProvidersFile();
	updateChain('chat', []);
	assert.deepEqual(readProvidersFile().chains.chat, []);
	updateChain('title', ['local-compat', 'ollama']);
	assert.deepEqual(readProvidersFile().chains.title, ['local-compat', 'ollama']);
});

test('the shipped providers.default.json resolves to FTS-only (embedding null) even though it has an ollama entry', () => {
	useTmpProvidersFile();
	fs.copyFileSync(path.join(process.cwd(), 'data', 'providers.default.json'), process.env.PROVIDERS_PATH!);
	assert.equal(getEmbeddingConfig(), null);
	assert.equal(readProvidersFile().providers.some((p) => p.id === 'ollama'), true);
});

// Aşama 4d — Ollama as an ordinary provider: re-adding it, and finding the one the model manager uses.
test('addProvider can add an Ollama-kind provider (native base URL, local timeouts, reasoning_content dialect, disabled until enabled)', () => {
	useTmpProvidersFile();
	deleteProvider('ollama');
	const entry = addProvider({ label: 'Ollama', baseUrl: 'http://127.0.0.1:11434/', kind: 'ollama', reasoningDialect: 'none' });
	assert.equal(entry.id, 'ollama');
	assert.equal(entry.kind, 'ollama');
	assert.equal(entry.baseUrl, 'http://127.0.0.1:11434');
	assert.equal(entry.reasoningDialect, 'reasoning_content');
	assert.equal(entry.enabled, false);
	assert.deepEqual(entry.timeouts, { connectMs: 30000, firstTokenMs: 300000, idleMs: 60000 });
	assert.equal(isCloud(entry), false);
});

test('getOllamaProviderId: first ENABLED ollama-kind provider, preferring id "ollama"; null when none', () => {
	useTmpProvidersFile();
	assert.equal(getOllamaProviderId(), 'ollama');
	updateProviderEnabled('ollama', false);
	assert.equal(getOllamaProviderId(), null);
	const second = addProvider({ label: 'Remote box', baseUrl: 'http://10.0.0.2:11434', kind: 'ollama', reasoningDialect: 'none' });
	updateProviderEnabled(second.id, true);
	assert.equal(getOllamaProviderId(), second.id);
	updateProviderEnabled('ollama', true);
	assert.equal(getOllamaProviderId(), 'ollama');
});
