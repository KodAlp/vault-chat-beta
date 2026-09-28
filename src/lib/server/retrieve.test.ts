import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { retrieve } from './retrieve';
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
