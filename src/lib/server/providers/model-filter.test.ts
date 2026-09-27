import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterModels, pickerModels } from './model-filter';
import type { Catalog, CatalogEntry } from './model-catalog';
import type { ModelInfo } from './types';
import type { ProviderConfigEntry } from './config-store';

const entry = (over: Partial<CatalogEntry> = {}): CatalogEntry => ({
	textOutput: true, toolCall: false, deprecated: false, releaseDate: Math.floor(Date.now() / 1000), contextLength: 8192, ...over
});

const model = (id: string, over: Partial<ModelInfo> = {}): ModelInfo => ({ id, ctx: 8192, caps: { tools: false, reasoning: false }, ...over });

function catalogFor(providerId: string, entries: Record<string, CatalogEntry>): Catalog {
	if (providerId === 'openrouter') return { openrouter: new Map(Object.entries(entries)), modelsDev: new Map(), fetchedAt: new Date().toISOString() };
	return { openrouter: new Map(), modelsDev: new Map([[providerId === 'google-ai-studio' ? 'google' : providerId, new Map(Object.entries(entries))]]), fetchedAt: new Date().toISOString() };
}

const NOW = new Date('2026-09-22T00:00:00.000Z');
const monthsAgo = (n: number) => Math.floor((NOW.getTime() - n * 30.44 * 86400 * 1000) / 1000);

test('a catalog-matched, text-output, non-deprecated, recent model is approved', () => {
	const catalog = catalogFor('groq', { 'model-a': entry({ releaseDate: monthsAgo(1) }) });
	const { approved, other } = filterModels('groq', [model('model-a')], catalog, { maxAgeMonths: 12, now: NOW });
	assert.deepEqual(approved.map((m) => m.id), ['model-a']);
	assert.deepEqual(other, []);
});

test('a catalog-matched but non-text-output model is dropped entirely, not demoted to "other"', () => {
	const catalog = catalogFor('groq', { 'whisper-x': entry({ textOutput: false }) });
	const { approved, other } = filterModels('groq', [model('whisper-x')], catalog, { maxAgeMonths: 12, now: NOW });
	assert.deepEqual(approved, []);
	assert.deepEqual(other, []);
});

test('a catalog-matched deprecated model is dropped', () => {
	const catalog = catalogFor('google-ai-studio', { 'gemini-old': entry({ deprecated: true }) });
	const { approved } = filterModels('google-ai-studio', [model('gemini-old')], catalog, { maxAgeMonths: 12, now: NOW });
	assert.deepEqual(approved, []);
});

test('a catalog-matched model older than maxAgeMonths is dropped; one just within the window is kept', () => {
	const catalog = catalogFor('groq', {
		'too-old': entry({ releaseDate: monthsAgo(13) }),
		'just-fine': entry({ releaseDate: monthsAgo(11) })
	});
	const { approved } = filterModels('groq', [model('too-old'), model('just-fine')], catalog, { maxAgeMonths: 12, now: NOW });
	assert.deepEqual(approved.map((m) => m.id), ['just-fine']);
});

test('a model with no catalog match at all goes to "other", is not dropped', () => {
	const catalog = catalogFor('groq', {});
	const { approved, other } = filterModels('groq', [model('unknown-model')], catalog, { maxAgeMonths: 12, now: NOW });
	assert.deepEqual(approved, []);
	assert.deepEqual(other.map((m) => m.id), ['unknown-model']);
});

test('a catalog-unmatched model with no release date at all (no catalog entry, no live created) has no age signal — still "other", never crashes', () => {
	const catalog = catalogFor('groq', {});
	const { other } = filterModels('groq', [model('mystery')], catalog, { maxAgeMonths: 12, now: NOW });
	assert.equal(other.length, 1);
});

test("a catalog-matched model with no releaseDate falls back to the live model's own `created` field", () => {
	const catalog = catalogFor('groq', { 'no-release-date': entry({ releaseDate: null }) });
	const oldByCreated = model('no-release-date', { created: monthsAgo(20) });
	const { approved } = filterModels('groq', [oldByCreated], catalog, { maxAgeMonths: 12, now: NOW });
	assert.deepEqual(approved, [], 'created fallback still enforces the age cutoff');
});

test('the openrouter provider looks itself up in the openrouter catalog, not models.dev', () => {
	const catalog = catalogFor('openrouter', { 'anthropic/claude-3-opus': entry() });
	const { approved } = filterModels('openrouter', [model('anthropic/claude-3-opus')], catalog, { maxAgeMonths: 12, now: NOW });
	assert.deepEqual(approved.map((m) => m.id), ['anthropic/claude-3-opus']);
});

test('order is preserved within each bucket', () => {
	const catalog = catalogFor('groq', { a: entry(), b: entry(), c: entry() });
	const { approved } = filterModels('groq', [model('c'), model('a'), model('b')], catalog, { maxAgeMonths: 12, now: NOW });
	assert.deepEqual(approved.map((m) => m.id), ['c', 'a', 'b']);
});

// pickerModels — problem B (union with pinnedModels) and the per-kind catalog skip (problem A local, ollama, azure-openai).

const providerEntry = (over: Partial<ProviderConfigEntry> = {}): Pick<ProviderConfigEntry, 'id' | 'kind' | 'local' | 'enabledModels' | 'pinnedModels'> => ({
	id: 'groq',
	kind: 'openai-compat',
	...over
});

test('pickerModels: approved (catalog-filtered) is returned as-is with no enabledModels/pinnedModels set', () => {
	const catalog = catalogFor('groq', { 'model-a': entry() });
	const result = pickerModels(providerEntry(), [model('model-a'), model('unknown')], catalog, { maxAgeMonths: 12, now: NOW });
	assert.deepEqual(result.map((m) => m.id), ['model-a']);
});

test('pickerModels: enabledModels narrows the approved set (never adds)', () => {
	const catalog = catalogFor('groq', { 'model-a': entry(), 'model-b': entry() });
	const result = pickerModels(
		providerEntry({ enabledModels: ['model-a'] }),
		[model('model-a'), model('model-b')],
		catalog,
		{ maxAgeMonths: 12, now: NOW }
	);
	assert.deepEqual(result.map((m) => m.id), ['model-a']);
});

test('pickerModels: pinnedModels unions in on top of the narrowed approved set, approved first then pinned-only', () => {
	const catalog = catalogFor('groq', { 'model-a': entry() });
	const result = pickerModels(
		providerEntry({ pinnedModels: ['pinned-unknown', 'model-a'] }),
		[model('model-a'), model('pinned-unknown', { ctx: 4096 })],
		catalog,
		{ maxAgeMonths: 12, now: NOW }
	);
	// model-a is already approved (stays first); pinned-unknown is appended once, using its live listModels() data.
	assert.deepEqual(result.map((m) => m.id), ['model-a', 'pinned-unknown']);
	assert.equal(result.find((m) => m.id === 'pinned-unknown')?.ctx, 4096);
});

test('pickerModels: a pinned id absent from listModels() gets a conservative placeholder, never dropped', () => {
	const catalog = catalogFor('groq', {});
	const result = pickerModels(providerEntry({ pinnedModels: ['deployment-x'] }), [], catalog, { maxAgeMonths: 12, now: NOW });
	assert.deepEqual(result, [{ id: 'deployment-x', ctx: 8192, caps: { tools: false, reasoning: false } }]);
});

test('pickerModels: never produces a duplicate id when a model is both approved and pinned', () => {
	const catalog = catalogFor('groq', { 'model-a': entry() });
	const result = pickerModels(providerEntry({ pinnedModels: ['model-a'] }), [model('model-a')], catalog, { maxAgeMonths: 12, now: NOW });
	assert.equal(result.length, 1);
});

test('pickerModels: ollama skips the catalog filter entirely — every listed model is approved', () => {
	const catalog = catalogFor('ollama', {});
	const result = pickerModels(providerEntry({ id: 'ollama', kind: 'ollama' }), [model('qwen3:8b'), model('mystery-local')], catalog, {
		maxAgeMonths: 12,
		now: NOW
	});
	assert.deepEqual(result.map((m) => m.id), ['qwen3:8b', 'mystery-local']);
});

test('pickerModels: a problem-A local openai-compat provider skips the catalog filter too', () => {
	const catalog = catalogFor('groq', {});
	const result = pickerModels(providerEntry({ local: true }), [model('lmstudio-community/some-gguf')], catalog, {
		maxAgeMonths: 12,
		now: NOW
	});
	assert.deepEqual(result.map((m) => m.id), ['lmstudio-community/some-gguf']);
});

test('pickerModels: azure-openai skips the catalog filter too', () => {
	const catalog = catalogFor('groq', {});
	const result = pickerModels(providerEntry({ kind: 'azure-openai' }), [model('my-gpt-deployment')], catalog, {
		maxAgeMonths: 12,
		now: NOW
	});
	assert.deepEqual(result.map((m) => m.id), ['my-gpt-deployment']);
});
