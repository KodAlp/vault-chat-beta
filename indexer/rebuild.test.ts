import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rebuildIndex, type RebuildProgress } from './rebuild';
import { openDb, listKnownFiles } from './db';
import { setEmbeddingConfig, type ProvidersFile } from '../src/lib/server/providers/config-store';

const OLLAMA: ProvidersFile['providers'][number] = {
	id: 'ollama',
	label: 'Ollama',
	baseUrl: 'http://127.0.0.1:11434/v1',
	kind: 'ollama',
	reasoningDialect: 'think-tags',
	enabled: true,
	timeouts: { connectMs: 5000, firstTokenMs: 120000, idleMs: 30000 }
};

function setup(): { dir: string; libraryRoot: string; dbPath: string } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebuild-test-'));
	fs.writeFileSync(
		path.join(dir, 'providers.json'),
		JSON.stringify({ providers: [OLLAMA], chains: { chat: ['ollama'] } } satisfies ProvidersFile, null, 2),
		'utf-8'
	);
	process.env.PROVIDERS_PATH = path.join(dir, 'providers.json');
	process.env.PROVIDER_CONSENT_PATH = path.join(dir, 'provider-consent.json');
	setEmbeddingConfig({ providerId: 'ollama', model: 'bge-m3', dims: 4 });
	const libraryRoot = path.join(dir, 'library');
	fs.mkdirSync(libraryRoot, { recursive: true });
	return { dir, libraryRoot, dbPath: path.join(dir, 'index.db') };
}

function note(libraryRoot: string, name: string, body: string): void {
	fs.writeFileSync(path.join(libraryRoot, name), `---\ntitle: "${name}"\n---\n\n## Section\n\n${body}\n`, 'utf-8');
}

function fakeEmbedFetch() {
	const real = globalThis.fetch;
	globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
		const input = JSON.parse(String(init?.body)).input as string[];
		return new Response(JSON.stringify({ embeddings: input.map(() => [0.1, 0.2, 0.3, 0.4]) }), { status: 200 });
	}) as typeof fetch;
	return () => (globalThis.fetch = real);
}

test('rebuildIndex indexes every file and reports a progress event per file plus a final one', async () => {
	const { libraryRoot, dbPath } = setup();
	note(libraryRoot, 'a.md', 'First note content.');
	note(libraryRoot, 'b.md', 'Second note content.');
	const restore = fakeEmbedFetch();
	try {
		const db = openDb(dbPath, { provider: 'ollama', model: 'bge-m3', dims: 4 });
		const events: RebuildProgress[] = [];
		const stats = await rebuildIndex(db, libraryRoot, { onProgress: (p) => events.push(p) });
		db.close();

		assert.equal(stats.indexed, 2);
		assert.equal(stats.skipped, 0);
		assert.equal(stats.deleted, 0);
		assert.equal(stats.chunks, 2); // one chunk per note here
		assert.ok(stats.ms >= 0);

		// One progress call per file (paths non-empty) plus one final call with path === ''.
		const withPath = events.filter((e) => e.path !== '');
		assert.equal(withPath.length, 2);
		assert.deepEqual(new Set(withPath.map((e) => e.path)), new Set(['a.md', 'b.md']));
		const final = events[events.length - 1];
		assert.equal(final.path, '');
		assert.equal(final.done, final.total);
		assert.equal(final.total, 2);
	} finally {
		restore();
	}
});

test('rebuildIndex skips a file whose content hash is unchanged', async () => {
	const { libraryRoot, dbPath } = setup();
	note(libraryRoot, 'a.md', 'Stable content.');
	const restore = fakeEmbedFetch();
	try {
		let db = openDb(dbPath, { provider: 'ollama', model: 'bge-m3', dims: 4 });
		await rebuildIndex(db, libraryRoot);
		db.close();

		db = openDb(dbPath, { provider: 'ollama', model: 'bge-m3', dims: 4 });
		const stats = await rebuildIndex(db, libraryRoot);
		db.close();
		assert.equal(stats.indexed, 0);
		assert.equal(stats.skipped, 1);
	} finally {
		restore();
	}
});

test('rebuildIndex deletes an index row for a file removed from disk', async () => {
	const { libraryRoot, dbPath } = setup();
	note(libraryRoot, 'a.md', 'Will be deleted.');
	const restore = fakeEmbedFetch();
	try {
		let db = openDb(dbPath, { provider: 'ollama', model: 'bge-m3', dims: 4 });
		await rebuildIndex(db, libraryRoot);
		db.close();

		fs.rmSync(path.join(libraryRoot, 'a.md'));
		db = openDb(dbPath, { provider: 'ollama', model: 'bge-m3', dims: 4 });
		const stats = await rebuildIndex(db, libraryRoot);
		assert.equal(stats.deleted, 1);
		assert.equal(listKnownFiles(db).size, 0);
		db.close();
	} finally {
		restore();
	}
});

test('rebuildIndex with dryRun writes nothing, even to a pre-existing db', async () => {
	const { libraryRoot, dbPath } = setup();
	note(libraryRoot, 'a.md', 'Content.');
	const restore = fakeEmbedFetch();
	try {
		const db = openDb(dbPath, { provider: 'ollama', model: 'bge-m3', dims: 4 });
		const stats = await rebuildIndex(db, libraryRoot, { dryRun: true });
		assert.equal(stats.indexed, 1); // counted as "would index"
		assert.equal(listKnownFiles(db).size, 0, 'nothing was actually written');
		db.close();
	} finally {
		restore();
	}
});

test('rebuildIndex throws AbortError immediately when the signal is already aborted, before any file is processed', async () => {
	const { libraryRoot, dbPath } = setup();
	note(libraryRoot, 'a.md', 'Content.');
	const restore = fakeEmbedFetch();
	try {
		const db = openDb(dbPath, { provider: 'ollama', model: 'bge-m3', dims: 4 });
		const controller = new AbortController();
		controller.abort();
		await assert.rejects(
			() => rebuildIndex(db, libraryRoot, { signal: controller.signal }),
			(err: unknown) => err instanceof DOMException && err.name === 'AbortError'
		);
		assert.equal(listKnownFiles(db).size, 0);
		db.close();
	} finally {
		restore();
	}
});

test('rebuildIndex aborted mid-walk stops before processing later files, leaving earlier writes in place', async () => {
	const { libraryRoot, dbPath } = setup();
	note(libraryRoot, 'one.md', 'Content one.');
	note(libraryRoot, 'two.md', 'Content two.');
	const restore = fakeEmbedFetch();
	try {
		const db = openDb(dbPath, { provider: 'ollama', model: 'bge-m3', dims: 4 });
		const controller = new AbortController();
		const seenPaths: string[] = [];
		await assert.rejects(
			() =>
				rebuildIndex(db, libraryRoot, {
					signal: controller.signal,
					// Order between the two files isn't guaranteed by fs.readdirSync,
					// so abort on whichever one is seen SECOND rather than naming one —
					// checkAborted() runs again right before that file's embed call.
					onProgress: (p) => {
						if (!p.path) return;
						seenPaths.push(p.path);
						if (seenPaths.length === 2) controller.abort();
					}
				}),
			(err: unknown) => err instanceof DOMException && err.name === 'AbortError'
		);
		assert.equal(seenPaths.length, 2);
		const known = listKnownFiles(db);
		assert.equal(known.has(seenPaths[0]), true, 'the first file processed made it in');
		assert.equal(known.has(seenPaths[1]), false, 'the second was aborted before its embed call');
		db.close();
	} finally {
		restore();
	}
});
