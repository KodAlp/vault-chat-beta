import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadCatalog, lookupCatalogEntry, normalizeModelId, type Fetcher } from './model-catalog';

// Real samples pulled from a live fetch of both endpoints before this module was written (see model-catalog.ts's
// doc comment) — trimmed to the fields the parser actually reads, but real ids/values, not invented shapes.
const OPENROUTER_SAMPLE = {
	data: [
		{
			id: 'xiaomi/mimo-v2.6-pro-ultraspeed',
			created: 1790021267,
			context_length: 1048576,
			architecture: { output_modalities: ['text'] },
			supported_parameters: ['tools', 'temperature']
		},
		{ id: 'some/audio-only-model', created: 1700000000, architecture: { output_modalities: ['audio'] }, supported_parameters: [] }
	]
};

const MODELS_DEV_SAMPLE = {
	google: {
		models: {
			'gemini-3.1-flash-lite-preview': {
				tool_call: true,
				status: 'deprecated',
				release_date: '2026-03-03',
				modalities: { output: ['text'] },
				limit: { context: 1048576 }
			},
			'gemini-2.5-flash': {
				tool_call: true,
				release_date: '2025-06-01',
				modalities: { output: ['text'] },
				limit: { context: 1000000 }
			}
		}
	},
	deepseek: {
		models: {
			'deepseek-v4-flash-vision-exp': {
				tool_call: true,
				release_date: '2026-09-10',
				modalities: { output: ['text'] },
				limit: { context: 1000000 }
			}
		}
	}
};

function stubFetch(): Fetcher {
	return (async (url: unknown) => {
		const u = String(url);
		if (u.includes('openrouter.ai')) return new Response(JSON.stringify(OPENROUTER_SAMPLE), { status: 200 });
		if (u.includes('models.dev')) return new Response(JSON.stringify(MODELS_DEV_SAMPLE), { status: 200 });
		return new Response('not found', { status: 404 });
	}) as unknown as Fetcher;
}

function useTmpCatalogPath(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-catalog-test-'));
	const p = path.join(dir, 'model-catalog.json');
	process.env.MODEL_CATALOG_PATH = p;
	return p;
}

test('normalizeModelId strips the "models/" prefix only for google-ai-studio', () => {
	assert.equal(normalizeModelId('google-ai-studio', 'models/gemini-2.5-flash'), 'gemini-2.5-flash');
	assert.equal(normalizeModelId('deepseek-api', 'models/should-not-strip'), 'models/should-not-strip');
	assert.equal(normalizeModelId('google-ai-studio', 'already-clean'), 'already-clean');
});

test('loadCatalog parses OpenRouter and models.dev into lookupable entries, on a fresh (uncached) fetch', async () => {
	useTmpCatalogPath();
	const catalog = await loadCatalog(stubFetch(), new Date());

	const or = lookupCatalogEntry(catalog, 'openrouter', 'xiaomi/mimo-v2.6-pro-ultraspeed');
	assert.deepEqual(or, { textOutput: true, toolCall: true, deprecated: false, releaseDate: 1790021267, contextLength: 1048576 });

	const google = lookupCatalogEntry(catalog, 'google-ai-studio', 'models/gemini-3.1-flash-lite-preview');
	assert.ok(google, 'the models/ prefix is stripped before lookup');
	assert.equal(google!.deprecated, true);
	assert.equal(google!.toolCall, true);
	assert.equal(google!.releaseDate, Math.floor(Date.parse('2026-03-03') / 1000));

	const deepseek = lookupCatalogEntry(catalog, 'deepseek-api', 'deepseek-v4-flash-vision-exp');
	assert.ok(deepseek);
	assert.equal(deepseek!.deprecated, false);
});

test('a provider not in PROVIDER_TO_CATALOG_KEY and not "openrouter" always misses (falls to "other" upstream)', async () => {
	useTmpCatalogPath();
	const catalog = await loadCatalog(stubFetch(), new Date());
	assert.equal(lookupCatalogEntry(catalog, 'ollama', 'qwen3:8b'), undefined);
});

test('an id absent from the catalog misses cleanly, does not throw', async () => {
	useTmpCatalogPath();
	const catalog = await loadCatalog(stubFetch(), new Date());
	assert.equal(lookupCatalogEntry(catalog, 'deepseek-api', 'no-such-model'), undefined);
});

test('a fresh fetch is cached to disk and a second call within the TTL never calls fetch again', async () => {
	useTmpCatalogPath();
	let calls = 0;
	const counting: Fetcher = (async (url: unknown, init?: RequestInit) => {
		calls++;
		return (stubFetch() as (u: unknown, i?: RequestInit) => Promise<Response>)(url, init);
	}) as unknown as Fetcher;

	const now = new Date('2026-01-01T00:00:00.000Z');
	await loadCatalog(counting, now);
	assert.equal(calls, 2, 'first call: both sources fetched');
	await loadCatalog(counting, new Date(now.getTime() + 1000));
	assert.equal(calls, 2, 'second call, same TTL window: served from disk cache, no new fetch');
});

test('an expired cache triggers a re-fetch', async () => {
	useTmpCatalogPath();
	let calls = 0;
	const counting: Fetcher = (async (url: unknown, init?: RequestInit) => {
		calls++;
		return (stubFetch() as (u: unknown, i?: RequestInit) => Promise<Response>)(url, init);
	}) as unknown as Fetcher;

	const day1 = new Date('2026-01-01T00:00:00.000Z');
	await loadCatalog(counting, day1);
	assert.equal(calls, 2);
	const day3 = new Date(day1.getTime() + 3 * 24 * 60 * 60 * 1000); // well past the 24h TTL
	await loadCatalog(counting, day3);
	assert.equal(calls, 4, 'the TTL expired, both sources were fetched again');
});

test('both fetches failing falls back to a stale cache instead of going empty', async () => {
	useTmpCatalogPath();
	const day1 = new Date('2026-01-01T00:00:00.000Z');
	await loadCatalog(stubFetch(), day1); // seeds a real cache

	const alwaysFails: Fetcher = (async () => {
		throw new Error('network down');
	}) as unknown as Fetcher;
	const day3 = new Date(day1.getTime() + 3 * 24 * 60 * 60 * 1000);
	const catalog = await loadCatalog(alwaysFails, day3);

	// still has the day1 data, even though the TTL had expired and the re-fetch failed
	assert.ok(lookupCatalogEntry(catalog, 'openrouter', 'xiaomi/mimo-v2.6-pro-ultraspeed'));
});

test('both fetches failing with no prior cache returns an empty (never-throwing) catalog', async () => {
	useTmpCatalogPath();
	const alwaysFails: Fetcher = (async () => {
		throw new Error('network down');
	}) as unknown as Fetcher;
	const catalog = await loadCatalog(alwaysFails, new Date());
	assert.equal(lookupCatalogEntry(catalog, 'openrouter', 'anything'), undefined);
});
