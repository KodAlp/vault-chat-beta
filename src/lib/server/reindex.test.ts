import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { reindexVault, cancelReindex, swapIndexIntoPlace, isReindexing, type RenameFn } from './reindex';
import { setEmbeddingConfig, type ProvidersFile } from './providers/config-store';
import { readIndexEmbedding } from '../../../indexer/db';
import { AppError } from './app-error';
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

function makeVault(): VaultContext {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reindex-test-'));
	fs.writeFileSync(
		path.join(dir, 'providers.json'),
		JSON.stringify({ providers: [OLLAMA], chains: { chat: ['ollama'] } } satisfies ProvidersFile, null, 2),
		'utf-8'
	);
	process.env.PROVIDERS_PATH = path.join(dir, 'providers.json');
	process.env.PROVIDER_CONSENT_PATH = path.join(dir, 'provider-consent.json');
	const v: VaultContext = {
		id: `reindex-test-${Math.random().toString(36).slice(2)}`,
		name: 'Test Vault',
		dir,
		libraryRoot: path.join(dir, 'library'),
		indexDbPath: path.join(dir, 'index.db'),
		studyDbPath: path.join(dir, 'study.db')
	};
	fs.mkdirSync(v.libraryRoot, { recursive: true });
	return v;
}

function note(libraryRoot: string, name: string, body: string): void {
	fs.writeFileSync(path.join(libraryRoot, name), `---\ntitle: "${name}"\n---\n\n## Section\n\n${body}\n`, 'utf-8');
}

function fakeEmbedFetch(dims = 4) {
	const real = globalThis.fetch;
	globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
		const input = JSON.parse(String(init?.body)).input as string[];
		return new Response(JSON.stringify({ embeddings: input.map(() => Array.from({ length: dims }, () => 0.1)) }), { status: 200 });
	}) as typeof fetch;
	return () => (globalThis.fetch = real);
}

// --- reindexVault ---

test('reindexVault builds a new index under the current config and replaces the old one', async () => {
	const v = makeVault();
	setEmbeddingConfig({ providerId: 'ollama', model: 'bge-m3', dims: 4 });
	note(v.libraryRoot, 'a.md', 'First note.');
	note(v.libraryRoot, 'b.md', 'Second note.');
	const restore = fakeEmbedFetch();
	try {
		const stats = await reindexVault(v);
		assert.equal(stats.files, 2);
		assert.equal(stats.chunks, 2);
		assert.ok(stats.ms >= 0);
		assert.equal(fs.existsSync(v.indexDbPath), true);
		assert.equal(fs.existsSync(`${v.indexDbPath}.rebuild`), false, 'temp file is gone');
		assert.equal(fs.existsSync(`${v.indexDbPath}.bak`), false, 'backup is cleaned up on success');

		const Database = (await import('better-sqlite3')).default;
		const db = new Database(v.indexDbPath, { readonly: true });
		assert.deepEqual(readIndexEmbedding(db), { provider: 'ollama', model: 'bge-m3', dims: 4 });
		const count = (db.prepare('SELECT count(*) AS n FROM files').get() as { n: number }).n;
		assert.equal(count, 2);
		db.close();
	} finally {
		restore();
	}
});

test('reindexVault replaces a pre-existing index built under a different config entirely', async () => {
	const v = makeVault();
	// Build an "old" index under one config first.
	setEmbeddingConfig({ providerId: 'ollama', model: 'old-model', dims: 4 });
	note(v.libraryRoot, 'old.md', 'Old content.');
	let restore = fakeEmbedFetch();
	await reindexVault(v);
	restore();

	// Now change config and reindex again — must fully replace, not merge.
	setEmbeddingConfig({ providerId: 'ollama', model: 'new-model', dims: 4 });
	fs.rmSync(path.join(v.libraryRoot, 'old.md'));
	note(v.libraryRoot, 'new.md', 'New content.');
	restore = fakeEmbedFetch();
	try {
		await reindexVault(v);
		const Database = (await import('better-sqlite3')).default;
		const db = new Database(v.indexDbPath, { readonly: true });
		assert.deepEqual(readIndexEmbedding(db), { provider: 'ollama', model: 'new-model', dims: 4 });
		const paths = (db.prepare('SELECT path FROM files').all() as { path: string }[]).map((r) => r.path);
		assert.deepEqual(paths, ['new.md']);
		db.close();
	} finally {
		restore();
	}
});

test('reindexVault refuses a concurrent second reindex for the same vault (REINDEX_IN_PROGRESS)', async () => {
	const v = makeVault();
	setEmbeddingConfig({ providerId: 'ollama', model: 'bge-m3', dims: 4 });
	note(v.libraryRoot, 'a.md', 'Content.');
	const restore = fakeEmbedFetch();
	try {
		const first = reindexVault(v);
		assert.equal(isReindexing(v.id), true);
		await assert.rejects(
			() => reindexVault(v),
			(err: unknown) => {
				assert.ok(err instanceof AppError);
				assert.equal(err.code, 'REINDEX_IN_PROGRESS');
				return true;
			}
		);
		await first;
		assert.equal(isReindexing(v.id), false);
	} finally {
		restore();
	}
});

test('a second, unrelated vault may reindex while the first is in progress', async () => {
	const v1 = makeVault();
	const v2 = makeVault();
	setEmbeddingConfig({ providerId: 'ollama', model: 'bge-m3', dims: 4 });
	note(v1.libraryRoot, 'a.md', 'Content.');
	note(v2.libraryRoot, 'a.md', 'Content.');
	const restore = fakeEmbedFetch();
	try {
		const p1 = reindexVault(v1);
		await assert.doesNotReject(() => reindexVault(v2));
		await p1;
	} finally {
		restore();
	}
});

test('cancelling mid-rebuild leaves the OLD index completely untouched and removes the temp file', async () => {
	const v = makeVault();
	setEmbeddingConfig({ providerId: 'ollama', model: 'bge-m3', dims: 4 });
	note(v.libraryRoot, 'old.md', 'Old content.');
	let restore = fakeEmbedFetch();
	await reindexVault(v); // establish a real "old" index
	restore();
	const oldBytes = fs.readFileSync(v.indexDbPath);

	note(v.libraryRoot, 'new.md', 'Triggers an embed call to cancel during.');
	restore = fakeEmbedFetch();
	try {
		await assert.rejects(
			() =>
				reindexVault(v, {
					onProgress: (p) => {
						if (p.path) cancelReindex(v.id);
					}
				}),
			(err: unknown) => err instanceof DOMException && err.name === 'AbortError'
		);
		assert.deepEqual(fs.readFileSync(v.indexDbPath), oldBytes, 'old index bytes unchanged');
		assert.equal(fs.existsSync(`${v.indexDbPath}.rebuild`), false);
		assert.equal(fs.existsSync(`${v.indexDbPath}.bak`), false);
		assert.equal(isReindexing(v.id), false);
	} finally {
		restore();
	}
});

test('cancelReindex on a vault with nothing running returns false', () => {
	assert.equal(cancelReindex('no-such-vault'), false);
});

// --- swapIndexIntoPlace ---

function writeFile(p: string, content: string): void {
	fs.writeFileSync(p, content, 'utf-8');
}

function tmpPaths(): { dbPath: string; tempPath: string } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swap-test-'));
	return { dbPath: path.join(dir, 'index.db'), tempPath: path.join(dir, 'index.db.rebuild') };
}

test('swapIndexIntoPlace moves the temp file into place and cleans up, including -wal sidecars', async () => {
	const { dbPath, tempPath } = tmpPaths();
	writeFile(dbPath, 'OLD');
	writeFile(`${dbPath}-wal`, 'OLD-WAL');
	writeFile(tempPath, 'NEW');
	writeFile(`${tempPath}-wal`, 'NEW-WAL');

	await swapIndexIntoPlace(dbPath, tempPath);

	assert.equal(fs.readFileSync(dbPath, 'utf-8'), 'NEW');
	assert.equal(fs.readFileSync(`${dbPath}-wal`, 'utf-8'), 'NEW-WAL');
	assert.equal(fs.existsSync(tempPath), false);
	assert.equal(fs.existsSync(`${dbPath}.bak`), false);
	assert.equal(fs.existsSync(`${dbPath}.bak-wal`), false);
});

test('swapIndexIntoPlace works when there was no old index at all (first-ever reindex)', async () => {
	const { dbPath, tempPath } = tmpPaths();
	writeFile(tempPath, 'NEW');
	await swapIndexIntoPlace(dbPath, tempPath);
	assert.equal(fs.readFileSync(dbPath, 'utf-8'), 'NEW');
});

function ebusyError(): NodeJS.ErrnoException {
	const err = new Error('EBUSY: resource busy or locked') as NodeJS.ErrnoException;
	err.code = 'EBUSY';
	return err;
}

test('swapIndexIntoPlace retries a transient lock and eventually succeeds', async () => {
	const { dbPath, tempPath } = tmpPaths();
	writeFile(dbPath, 'OLD');
	writeFile(tempPath, 'NEW');

	let failuresLeft = 2;
	const renameFn: RenameFn = (from, to) => {
		if (from.includes('.rebuild') && failuresLeft > 0) {
			failuresLeft--;
			throw ebusyError();
		}
		fs.renameSync(from, to);
	};

	await swapIndexIntoPlace(dbPath, tempPath, renameFn);
	assert.equal(fs.readFileSync(dbPath, 'utf-8'), 'NEW');
	assert.equal(fs.existsSync(`${dbPath}.bak`), false);
	assert.equal(failuresLeft, 0);
});

test('swapIndexIntoPlace gives up after repeated lock failures, restoring the OLD index and deleting the temp (REINDEX_INDEX_LOCKED)', async () => {
	const { dbPath, tempPath } = tmpPaths();
	writeFile(dbPath, 'ORIGINAL OLD CONTENT');
	writeFile(tempPath, 'NEW');

	// The rename FROM the temp file always fails (simulates another process,
	// e.g. the MCP server, permanently holding index.db open); renaming the
	// old file to .bak always succeeds — so every attempt must roll the old
	// file back into place before retrying.
	const renameFn: RenameFn = (from, to) => {
		if (from.includes('.rebuild')) throw ebusyError();
		fs.renameSync(from, to);
	};

	await assert.rejects(
		() => swapIndexIntoPlace(dbPath, tempPath, renameFn),
		(err: unknown) => {
			assert.ok(err instanceof AppError);
			assert.equal(err.code, 'REINDEX_INDEX_LOCKED');
			return true;
		}
	);
	assert.equal(fs.readFileSync(dbPath, 'utf-8'), 'ORIGINAL OLD CONTENT', 'old index fully restored');
	assert.equal(fs.existsSync(tempPath), false, 'temp file discarded');
	assert.equal(fs.existsSync(`${dbPath}.bak`), false, 'no leftover backup');
});

test('swapIndexIntoPlace gives up immediately on a non-transient error (no retry loop), fully restoring the old index', async () => {
	const { dbPath, tempPath } = tmpPaths();
	writeFile(dbPath, 'ORIGINAL');
	writeFile(tempPath, 'NEW');
	let calls = 0;
	const renameFn: RenameFn = (from, to) => {
		calls++;
		if (from.includes('.rebuild')) {
			const err = new Error('ENOSPC') as NodeJS.ErrnoException;
			err.code = 'ENOSPC';
			throw err;
		}
		fs.renameSync(from, to);
	};
	await assert.rejects(() => swapIndexIntoPlace(dbPath, tempPath, renameFn), (err: unknown) => err instanceof AppError && err.code === 'REINDEX_INDEX_LOCKED');
	// old->bak, then temp->real (fails), then bak->old (rollback) = 3 calls, not RENAME_ATTEMPTS*3.
	assert.equal(calls, 3);
	assert.equal(fs.readFileSync(dbPath, 'utf-8'), 'ORIGINAL', 'old index restored, not lost, on a non-retryable failure');
	assert.equal(fs.existsSync(`${dbPath}.bak`), false);
});
