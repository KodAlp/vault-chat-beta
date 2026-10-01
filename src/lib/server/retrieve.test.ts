import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { retrieve, checkEmbeddingMismatch } from './retrieve';
import { setEmbeddingConfig, type ProvidersFile } from './providers/config-store';
import { openDb, upsertFile } from '../../../indexer/db';
import type { VaultContext } from './vaults';

const OLLAMA: ProvidersFile['providers'][number] = {
	id: 'ollama',
	label: 'Ollama',
	baseUrl: 'http://127.0.0.1:11434/v1',
	kind: 'ollama',
	reasoningDialect: 'think-tags',
	enabled: true,
	timeouts: { connectMs: 5000, firstTokenMs: 120000, idleMs: 30000 }
};

const CHUNK_TEXT = 'quicksort partition algorithm picks a pivot element';
const QUERY = 'quicksort partition algorithm';

/**
 * Aşama 3a — builds a real, tiny index.db (via indexer/db.ts, same as the
 * indexer/app write path) with one file/chunk embedded under `indexMeta`, so
 * retrieve() runs its real KNN + FTS5 machinery instead of a mock. Each test
 * gets a fresh vault id/dir (no dbCache collisions across tests — retrieve.ts
 * caches one connection per vault id for the process lifetime).
 */
function setup(indexMeta: { provider: string; model: string; dims: number }): VaultContext {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retrieve-test-'));
	fs.writeFileSync(
		path.join(dir, 'providers.json'),
		JSON.stringify({ providers: [OLLAMA], chains: { chat: ['ollama'] } } satisfies ProvidersFile, null, 2),
		'utf-8'
	);
	process.env.PROVIDERS_PATH = path.join(dir, 'providers.json');
	process.env.PROVIDER_CONSENT_PATH = path.join(dir, 'provider-consent.json');

	const vault: VaultContext = {
		id: `retrieve-test-${Math.random().toString(36).slice(2)}`,
		name: 'Test Vault',
		dir,
		libraryRoot: path.join(dir, 'library'),
		indexDbPath: path.join(dir, 'index.db'),
		studyDbPath: path.join(dir, 'study.db')
	};
	fs.mkdirSync(vault.libraryRoot, { recursive: true });

	const db = openDb(vault.indexDbPath, indexMeta);
	const vector = Array.from({ length: indexMeta.dims }, (_, i) => (i === 0 ? 1 : 0));
	upsertFile(
		db,
		{ path: 'a.md', sha256: 'x', mtime: 1, topic: 'Quicksort', depth: 'undergrad', domains_json: '["algorithms"]', prerequisites_json: '[]' },
		[{ insert: { path: 'a.md', heading_path: 'Quicksort', display_text: CHUNK_TEXT }, embedding: vector }]
	);
	db.close();
	return vault;
}

function fakeFetch(handler: (url: string, init?: RequestInit) => Response) {
	const real = globalThis.fetch;
	globalThis.fetch = (async (url: unknown, init?: RequestInit) => handler(String(url), init)) as typeof fetch;
	return () => (globalThis.fetch = real);
}

test('a normal query (config matches index, embed succeeds) returns vector matches with no embeddingIssue', async () => {
	const vault = setup({ provider: 'ollama', model: 'bge-m3', dims: 3 });
	setEmbeddingConfig({ providerId: 'ollama', model: 'bge-m3', dims: 3 });
	const restore = fakeFetch(() => new Response(JSON.stringify({ embeddings: [[1, 0, 0]] }), { status: 200 }));
	try {
		const result = await retrieve(vault, QUERY, {});
		assert.equal(result.embeddingIssue, undefined);
		assert.equal(result.chunks.length, 1);
		assert.equal(result.chunks[0].path, 'a.md');
		assert.equal(result.keyword, undefined);
	} finally {
		restore();
	}
});

test('an index/config mismatch skips vector search, sets embeddingIssue:"mismatch", and falls back to keyword search', async () => {
	const vault = setup({ provider: 'ollama', model: 'old-model', dims: 3 });
	setEmbeddingConfig({ providerId: 'ollama', model: 'bge-m3', dims: 3 }); // different model than the index was built with
	let fetchCalled = false;
	const restore = fakeFetch(() => {
		fetchCalled = true;
		return new Response(JSON.stringify({ embeddings: [[1, 0, 0]] }), { status: 200 });
	});
	try {
		const result = await retrieve(vault, QUERY, {});
		assert.equal(fetchCalled, false, 'vector search must not even attempt to embed on a mismatch');
		assert.equal(result.embeddingIssue, 'mismatch');
		assert.equal(result.chunks.length, 1, 'the FTS keyword fallback still finds the chunk');
		assert.equal(result.keyword, true);
	} finally {
		restore();
	}
});

test('an embed failure (EMBEDDING_UNAVAILABLE) sets embeddingIssue:"unavailable" and falls back to keyword search, even without opts.keywordFallback', async () => {
	const vault = setup({ provider: 'ollama', model: 'bge-m3', dims: 3 });
	setEmbeddingConfig({ providerId: 'ollama', model: 'bge-m3', dims: 3 }); // matches the index — the embed CALL itself fails
	const restore = fakeFetch(() => new Response('boom', { status: 500 }));
	try {
		const result = await retrieve(vault, QUERY, {}); // no keywordFallback opt at all — matches how the 5 generators call retrieve()
		assert.equal(result.embeddingIssue, 'unavailable');
		assert.equal(result.chunks.length, 1);
		assert.equal(result.keyword, true);
	} finally {
		restore();
	}
});

test('a mismatch with no keyword hit still reports embeddingIssue, with an empty chunk list', async () => {
	const vault = setup({ provider: 'ollama', model: 'old-model', dims: 3 });
	setEmbeddingConfig({ providerId: 'ollama', model: 'bge-m3', dims: 3 });
	const restore = fakeFetch(() => new Response(JSON.stringify({ embeddings: [[1, 0, 0]] }), { status: 200 }));
	try {
		const result = await retrieve(vault, 'completely unrelated terms here', {});
		assert.equal(result.embeddingIssue, 'mismatch');
		assert.equal(result.chunks.length, 0);
	} finally {
		restore();
	}
});

// Aşama 4a — FTS-only mode and a vanished embedding provider.
function setupFtsOnly(): VaultContext {
	const vault = setup({ provider: 'ollama', model: 'bge-m3', dims: 3 });
	fs.rmSync(vault.indexDbPath, { force: true });
	fs.rmSync(vault.indexDbPath + '-wal', { force: true });
	fs.rmSync(vault.indexDbPath + '-shm', { force: true });
	const db = openDb(vault.indexDbPath, null);
	upsertFile(
		db,
		{ path: 'a.md', sha256: 'x', mtime: 1, topic: 'Quicksort', depth: 'undergrad', domains_json: '["algorithms"]', prerequisites_json: '[]' },
		[{ insert: { path: 'a.md', heading_path: 'Quicksort', display_text: CHUNK_TEXT }, embedding: null }]
	);
	db.close();
	return vault;
}

function failingFetch() {
	const state = { called: false };
	const restore = fakeFetch(() => {
		state.called = true;
		return new Response('must not be called', { status: 500 });
	});
	return { state, restore };
}

test('FTS-only mode (embedding null): retrieve never throws, never embeds, and answers from keyword search with embeddingIssue:"fts-only"', async () => {
	const vault = setupFtsOnly();
	setEmbeddingConfig(null);
	const { state, restore } = failingFetch();
	try {
		const result = await retrieve(vault, QUERY, {});
		assert.equal(state.called, false);
		assert.equal(result.embeddingIssue, 'fts-only');
		assert.equal(result.chunks.length, 1);
		assert.equal(result.chunks[0].path, 'a.md');
		assert.equal(result.keyword, true);
	} finally {
		restore();
	}
});

test('FTS-only mode with no keyword hit reports reason "fts-only", not the misleading "no-embedding-match"', async () => {
	const vault = setupFtsOnly();
	setEmbeddingConfig(null);
	const { restore } = failingFetch();
	try {
		const result = await retrieve(vault, 'completely unrelated terms here', {});
		assert.equal(result.chunks.length, 0);
		assert.equal(result.embeddingIssue, 'fts-only');
		assert.equal(result.reason, 'fts-only');
	} finally {
		restore();
	}
});

test('a null embedding config on an index that still holds vectors is also FTS-only (no embed call, no mismatch)', async () => {
	const vault = setup({ provider: 'ollama', model: 'bge-m3', dims: 3 });
	setEmbeddingConfig(null);
	const { state, restore } = failingFetch();
	try {
		const result = await retrieve(vault, QUERY, {});
		assert.equal(state.called, false);
		assert.equal(result.embeddingIssue, 'fts-only');
		assert.equal(result.chunks.length, 1);
		assert.equal(checkEmbeddingMismatch(vault).mismatch, false);
	} finally {
		restore();
	}
});

test('checkEmbeddingMismatch: FTS-only index + null config is fine; choosing a provider afterwards mismatches', () => {
	const vault = setupFtsOnly();
	setEmbeddingConfig(null);
	const idle = checkEmbeddingMismatch(vault);
	assert.equal(idle.mismatch, false);
	assert.equal(idle.config, null);
	setEmbeddingConfig({ providerId: 'ollama', model: 'bge-m3', dims: 3 });
	const after = checkEmbeddingMismatch(vault);
	assert.equal(after.mismatch, true);
	assert.deepEqual(after.index, { provider: 'none', model: 'none', dims: 0 });
});

test('a configured provider that no longer exists (NOT_FOUND) falls back to keyword search instead of throwing', async () => {
	const vault = setup({ provider: 'ghost', model: 'bge-m3', dims: 3 });
	// setEmbeddingConfig() would reject an unknown provider, so write the dangling block directly —
	// exactly the state a hand-edited or partially migrated providers.json leaves behind.
	fs.writeFileSync(
		process.env.PROVIDERS_PATH!,
		JSON.stringify({ providers: [OLLAMA], chains: { chat: ['ollama'] }, embedding: { providerId: 'ghost', model: 'bge-m3', dims: 3 } } satisfies ProvidersFile, null, 2),
		'utf-8'
	);
	const { state, restore } = failingFetch();
	try {
		const result = await retrieve(vault, QUERY, {});
		assert.equal(state.called, false);
		assert.equal(result.embeddingIssue, 'unavailable');
		assert.equal(result.chunks.length, 1);
		assert.equal(result.keyword, true);
	} finally {
		restore();
	}
});

test('an embedding outage with no keyword hit reports reason "embedding-unavailable", not "no-embedding-match"', async () => {
	const vault = setup({ provider: 'ollama', model: 'bge-m3', dims: 3 });
	setEmbeddingConfig({ providerId: 'ollama', model: 'bge-m3', dims: 3 });
	const restore = fakeFetch(() => new Response('boom', { status: 500 }));
	try {
		const result = await retrieve(vault, 'completely unrelated terms here', {});
		assert.equal(result.embeddingIssue, 'unavailable');
		assert.equal(result.chunks.length, 0);
		assert.equal(result.reason, 'embedding-unavailable');
	} finally {
		restore();
	}
});

test('generator-style call (no keywordFallback, long topic+summary query, keywordQuery = topic) finds keyword hits in FTS-only mode', async () => {
	const vault = setupFtsOnly();
	setEmbeddingConfig(null);
	const { restore } = failingFetch();
	try {
		const longQuery = QUERY + ' ' + 'summary words that appear nowhere in the vault '.repeat(8);
		const withoutKeywordQuery = await retrieve(vault, longQuery, {});
		assert.equal(withoutKeywordQuery.chunks.length, 0, 'the AND-ed long query alone matches nothing');
		const result = await retrieve(vault, longQuery, { keywordQuery: QUERY, k: 12 });
		assert.equal(result.embeddingIssue, 'fts-only');
		assert.equal(result.chunks.length, 1);
	} finally {
		restore();
	}
});

test('a one-word query in FTS-only mode yields no chunks (buildFallbackQuery needs >= 2 terms), with reason "fts-only"', async () => {
	const vault = setupFtsOnly();
	setEmbeddingConfig(null);
	const { restore } = failingFetch();
	try {
		const result = await retrieve(vault, 'quicksort', {});
		assert.equal(result.chunks.length, 0);
		assert.equal(result.reason, 'fts-only');
	} finally {
		restore();
	}
});
