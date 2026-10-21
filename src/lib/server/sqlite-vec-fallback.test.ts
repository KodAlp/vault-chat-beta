import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, upsertFile, readIndexEmbedding, isFtsOnlyIndex } from '../../../indexer/db';
import { keywordSearch } from './keyword-search';
import { hasSqliteVec, setSqliteVecLoaderForTest } from './sqlite-vec-loader';
import { retrieve } from './retrieve';
import { setEmbeddingConfig, type ProvidersFile } from './providers/config-store';
import type { VaultContext } from './vaults';

// Simulates a platform with no sqlite-vec binary (windows-arm64): the vault must still open and search by keyword.
after(() => setSqliteVecLoaderForTest(null));

const failLoad = () => {
	throw new Error('simulated: no sqlite-vec for this platform');
};
const hasTable = (db: ReturnType<typeof openDb>, name: string) =>
	db.prepare('SELECT 1 FROM sqlite_master WHERE name = ?').get(name) !== undefined;
const FILE = { path: 'a.md', sha256: 'x', mtime: 1, topic: 'Quicksort', depth: 'undergrad', domains_json: '[]', prerequisites_json: '[]' };
const TEXT = 'quicksort partition algorithm picks a pivot element';

test('without sqlite-vec: the index opens, FTS finds the chunk, no vec table, meta says FTS-only', () => {
	setSqliteVecLoaderForTest(failLoad);
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-novec-'));
	// A real embedding is passed on purpose: it must be written without vectors, not fail.
	const db = openDb(path.join(dir, 'index.db'), { provider: 'ollama', model: 'bge-m3', dims: 3 });
	assert.equal(hasSqliteVec(db), false);
	upsertFile(db, FILE, [{ insert: { path: 'a.md', heading_path: 'Quicksort', display_text: TEXT }, embedding: [1, 0, 0] }]);
	assert.equal(hasTable(db, 'vec_chunks'), false);
	assert.equal(keywordSearch(db, 'quicksort', 5).length, 1);
	assert.equal(isFtsOnlyIndex(readIndexEmbedding(db)), true);
	db.close();
});

test('without sqlite-vec: retrieve() answers from keyword search as fts-only and never calls the embedder', async () => {
	setSqliteVecLoaderForTest(failLoad);
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-novec-ret-'));
	fs.writeFileSync(
		path.join(dir, 'providers.json'),
		JSON.stringify(
			{
				providers: [{ id: 'ollama', label: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1', kind: 'ollama', reasoningDialect: 'think-tags', enabled: true, timeouts: { connectMs: 5000, firstTokenMs: 120000, idleMs: 30000 } }],
				chains: { chat: ['ollama'] }
			} satisfies ProvidersFile
		)
	);
	process.env.PROVIDERS_PATH = path.join(dir, 'providers.json');
	process.env.PROVIDER_CONSENT_PATH = path.join(dir, 'provider-consent.json');
	const vault: VaultContext = {
		id: `novec-${Math.random().toString(36).slice(2)}`,
		name: 'T',
		dir,
		libraryRoot: path.join(dir, 'library'),
		indexDbPath: path.join(dir, 'index.db'),
		studyDbPath: path.join(dir, 'study.db')
	};
	const db = openDb(vault.indexDbPath, { provider: 'ollama', model: 'bge-m3', dims: 3 });
	upsertFile(db, FILE, [{ insert: { path: 'a.md', heading_path: 'Quicksort', display_text: TEXT }, embedding: [1, 0, 0] }]);
	db.close();
	setEmbeddingConfig({ providerId: 'ollama', model: 'bge-m3', dims: 3 });
	const realFetch = globalThis.fetch;
	let fetched = false;
	globalThis.fetch = (async () => {
		fetched = true;
		return new Response('no', { status: 500 });
	}) as typeof fetch;
	try {
		const result = await retrieve(vault, 'quicksort partition algorithm', {});
		assert.equal(fetched, false);
		assert.equal(result.embeddingIssue, 'fts-only');
		assert.equal(result.chunks.length, 1);
		assert.equal(result.keyword, true);
	} finally {
		globalThis.fetch = realFetch;
	}
});
