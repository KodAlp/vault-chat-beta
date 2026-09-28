import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { indexLibraryFile } from './incrementalIndex';
import { setEmbeddingConfig, type ProvidersFile } from './providers/config-store';
import { AppError } from './app-error';
import { openDb } from '../../../indexer/db';
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

/**
 * Aşama 3a — indexLibraryFile is the app's live single-file write path (used
 * by upload/import so a new document is searchable immediately); it must
 * refuse to mix vectors from the CURRENTLY configured embedding provider
 * into an index whose vec_chunks table was baked for a different one (the
 * dimension is fixed in that table's DDL) instead of silently corrupting it
 * or throwing an opaque SQLite error.
 */
function setup(): { vault: VaultContext; notePath: string } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'incremental-index-test-'));
	fs.writeFileSync(path.join(dir, 'providers.json'), JSON.stringify({ providers: [OLLAMA], chains: { chat: ['ollama'] } } satisfies ProvidersFile, null, 2), 'utf-8');
	process.env.PROVIDERS_PATH = path.join(dir, 'providers.json');
	process.env.PROVIDER_CONSENT_PATH = path.join(dir, 'provider-consent.json');

	const vault: VaultContext = {
		id: `test-${Math.random().toString(36).slice(2)}`,
		name: 'Test Vault',
		dir,
		libraryRoot: path.join(dir, 'library'),
		indexDbPath: path.join(dir, 'index.db'),
		studyDbPath: path.join(dir, 'study.db')
	};
	fs.mkdirSync(vault.libraryRoot, { recursive: true });
	const notePath = path.join(vault.libraryRoot, 'note.md');
	fs.writeFileSync(notePath, '---\ntitle: "Test Note"\n---\n\n## Section\n\nSome real content to chunk and embed.\n', 'utf-8');
	return { vault, notePath };
}

function fakeEmbedFetch(dims: number) {
	const real = globalThis.fetch;
	globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
		const input = JSON.parse(String(init?.body)).input as string[];
		return new Response(JSON.stringify({ embeddings: input.map(() => Array.from({ length: dims }, () => 0.1)) }), { status: 200 });
	}) as typeof fetch;
	return () => (globalThis.fetch = real);
}

test('indexLibraryFile writes chunks/vectors and records the current embedding config as meta on a brand-new index', async () => {
	const { vault, notePath } = setup();
	setEmbeddingConfig({ providerId: 'ollama', model: 'bge-m3', dims: 4 });
	const restore = fakeEmbedFetch(4);
	try {
		await indexLibraryFile(vault, notePath, 'note.md');
		const db = openDb(vault.indexDbPath);
		try {
			const count = (db.prepare('SELECT count(*) AS n FROM files').get() as { n: number }).n;
			assert.equal(count, 1);
		} finally {
			db.close();
		}
	} finally {
		restore();
	}
});

test('indexLibraryFile refuses to write into an index built under a different embedding config (EMBEDDING_MISMATCH)', async () => {
	const { vault, notePath } = setup();
	// Pre-create the index under a DIFFERENT embedding than what's configured now.
	openDb(vault.indexDbPath, { provider: 'ollama', model: 'some-old-model', dims: 5 }).close();
	setEmbeddingConfig({ providerId: 'ollama', model: 'bge-m3', dims: 4 });
	const restore = fakeEmbedFetch(4);
	try {
		await assert.rejects(
			() => indexLibraryFile(vault, notePath, 'note.md'),
			(err: unknown) => {
				assert.ok(err instanceof AppError);
				assert.equal(err.code, 'EMBEDDING_MISMATCH');
				return true;
			}
		);
		const db = openDb(vault.indexDbPath);
		try {
			const count = (db.prepare('SELECT count(*) AS n FROM files').get() as { n: number }).n;
			assert.equal(count, 0, 'nothing was written despite the refusal');
		} finally {
			db.close();
		}
	} finally {
		restore();
	}
});

test('indexLibraryFile succeeds when the config matches the index (including the legacy default)', async () => {
	const { vault, notePath } = setup();
	// No setEmbeddingConfig() call at all — getEmbeddingConfig() returns the
	// legacy default, and a brand-new index gets exactly that as its meta, so
	// this must succeed without ever seeing EMBEDDING_MISMATCH.
	const restore = fakeEmbedFetch(1024);
	try {
		await assert.doesNotReject(() => indexLibraryFile(vault, notePath, 'note.md'));
	} finally {
		restore();
	}
});
