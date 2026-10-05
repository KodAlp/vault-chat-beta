import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeLibraryFile, listRevisions, readRevision, restoreRevision, sha256, type Indexer } from './library-write';
import { AppError } from './app-error';
import type { VaultContext } from './vaults';

function hasCode(code: string) {
	return (err: unknown) => err instanceof AppError && err.code === code;
}

function tmpVault(): VaultContext {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'library-write-test-'));
	const libraryRoot = path.join(dir, 'library');
	fs.mkdirSync(libraryRoot, { recursive: true });
	return {
		id: 'test',
		name: 'Test',
		dir,
		libraryRoot,
		indexDbPath: path.join(dir, 'index.db'),
		studyDbPath: path.join(dir, 'study.db')
	};
}

// Real indexing needs an embedding backend; the contract under test here is
// the file/revision/log handling, so the indexer is stubbed.
const calls: string[] = [];
const stubIndexer: Indexer = async (_v, _abs, rel) => {
	calls.push(rel);
};

function seed(v: VaultContext, rel = 'note.md', text = 'v0'): string {
	const abs = path.join(v.libraryRoot, rel);
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	fs.writeFileSync(abs, text);
	return abs;
}

test('writeLibraryFile replaces content, returns the new hash and indexes', async () => {
	const v = tmpVault();
	const abs = seed(v);
	calls.length = 0;
	const res = await writeLibraryFile(v, 'note.md', 'v1', sha256('v0'), { indexer: stubIndexer });
	assert.equal(fs.readFileSync(abs, 'utf-8'), 'v1');
	assert.equal(res.hash, sha256('v1'));
	assert.equal(res.indexPending, false);
	assert.deepEqual(calls, ['note.md']);
	// No temp file left behind.
	assert.deepEqual(fs.readdirSync(v.libraryRoot).filter((n) => n.includes('.tmp-')), []);
});

test('rejects traversal, _meta, non-.md, missing files and symlinks', async () => {
	const v = tmpVault();
	seed(v);
	fs.mkdirSync(path.join(v.libraryRoot, '_meta'));
	fs.writeFileSync(path.join(v.libraryRoot, '_meta', 'x.md'), 'm');
	fs.writeFileSync(path.join(v.libraryRoot, 'a.txt'), 't');
	const w = (rel: string) => writeLibraryFile(v, rel, 'z', sha256('v0'), { indexer: stubIndexer });

	await assert.rejects(() => w('../x.md'), hasCode('PATH_OUTSIDE_LIBRARY'));
	await assert.rejects(() => w('_meta/x.md'), hasCode('LIBRARY_EDIT_FORBIDDEN'));
	await assert.rejects(() => w('_META/x.md'), hasCode('LIBRARY_EDIT_FORBIDDEN'));
	await assert.rejects(() => w('a.txt'), hasCode('LIBRARY_EDIT_FORBIDDEN'));
	await assert.rejects(() => w('missing.md'), hasCode('LIBRARY_EDIT_FORBIDDEN'));
	assert.equal(fs.readFileSync(path.join(v.libraryRoot, '_meta', 'x.md'), 'utf-8'), 'm');

	const outside = path.join(v.dir, 'outside.md');
	fs.writeFileSync(outside, 'o');
	try {
		fs.symlinkSync(outside, path.join(v.libraryRoot, 'link.md'));
	} catch {
		return; // symlink creation needs privileges on some Windows setups
	}
	await assert.rejects(() => w('link.md'), hasCode('LIBRARY_EDIT_FORBIDDEN'));
	assert.equal(fs.readFileSync(outside, 'utf-8'), 'o');
});

test('stale baseHash is a conflict and leaves the file untouched', async () => {
	const v = tmpVault();
	const abs = seed(v);
	await assert.rejects(
		() => writeLibraryFile(v, 'note.md', 'mine', sha256('something else'), { indexer: stubIndexer }),
		hasCode('LIBRARY_EDIT_CONFLICT')
	);
	assert.equal(fs.readFileSync(abs, 'utf-8'), 'v0');
	assert.deepEqual(listRevisions(v, 'note.md'), []);
});

test('oversized content is refused', async () => {
	const v = tmpVault();
	seed(v);
	const big = 'a'.repeat(10 * 1024 * 1024 + 1);
	await assert.rejects(() => writeLibraryFile(v, 'note.md', big, sha256('v0'), { indexer: stubIndexer }), hasCode('FILE_TOO_LARGE'));
});

test('each save snapshots the previous text; only the newest 20 are kept', async () => {
	const v = tmpVault();
	seed(v, 'sub/n.md', 'v0');
	let cur = 'v0';
	for (let i = 1; i <= 25; i++) {
		const next = 'v' + i;
		await writeLibraryFile(v, 'sub/n.md', next, sha256(cur), { indexer: stubIndexer });
		cur = next;
	}
	const revs = listRevisions(v, 'sub/n.md');
	assert.equal(revs.length, 20);
	// Newest first: the last snapshot holds v24 (the text replaced by the 25th save).
	assert.equal(readRevision(v, 'sub/n.md', revs[0].id), 'v24');
	assert.equal(readRevision(v, 'sub/n.md', revs[19].id), 'v5');
	assert.ok(revs[0].id > revs[1].id);
	assert.match(revs[0].at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
	assert.equal(revs[0].bytes, 3);
});

test('readRevision validates the id strictly', () => {
	const v = tmpVault();
	seed(v);
	for (const id of ['../../note.md', 'x.md', '..', '2026-01-01T00-00-00-000Z.md/../x', '']) {
		assert.throws(() => readRevision(v, 'note.md', id), hasCode('LIBRARY_REVISION_NOT_FOUND'));
	}
	assert.throws(() => readRevision(v, 'note.md', '2026-01-01T00-00-00-000Z.md'), hasCode('LIBRARY_REVISION_NOT_FOUND'));
});

test('restoreRevision goes through a normal save (snapshots current)', async () => {
	const v = tmpVault();
	const abs = seed(v);
	await writeLibraryFile(v, 'note.md', 'v1', sha256('v0'), { indexer: stubIndexer });
	const [rev] = listRevisions(v, 'note.md');
	const res = await restoreRevision(v, 'note.md', rev.id, sha256('v1'), { indexer: stubIndexer });
	assert.equal(fs.readFileSync(abs, 'utf-8'), 'v0');
	assert.equal(res.hash, sha256('v0'));
	const after = listRevisions(v, 'note.md');
	assert.equal(after.length, 2);
	assert.equal(readRevision(v, 'note.md', after[0].id), 'v1');
});

test('an edit-log line is appended per save', async () => {
	const v = tmpVault();
	seed(v);
	await writeLibraryFile(v, 'note.md', 'héllo', sha256('v0'), { by: 'user', indexer: stubIndexer });
	const lines = fs.readFileSync(path.join(v.libraryRoot, '_meta', 'edit-log.jsonl'), 'utf-8').trim().split('\n');
	assert.equal(lines.length, 1);
	const e = JSON.parse(lines[0]);
	assert.equal(e.path, 'note.md');
	assert.equal(e.bytesBefore, 2);
	assert.equal(e.bytesAfter, 6); // é is 2 bytes in utf-8
	assert.equal(e.by, 'user');
	assert.ok(!Number.isNaN(Date.parse(e.at)));
});

test('index trouble never fails a save: reindex in progress / other errors become flags', async () => {
	const v = tmpVault();
	const abs = seed(v);
	const busy: Indexer = async () => {
		throw new AppError('REINDEX_IN_PROGRESS', undefined, 409);
	};
	const r1 = await writeLibraryFile(v, 'note.md', 'v1', sha256('v0'), { indexer: busy });
	assert.deepEqual({ p: r1.indexPending, e: r1.indexError }, { p: true, e: undefined });

	const broken: Indexer = async () => {
		throw new AppError('EMBEDDING_MISMATCH', undefined, 409);
	};
	const r2 = await writeLibraryFile(v, 'note.md', 'v2', sha256('v1'), { indexer: broken });
	assert.deepEqual({ p: r2.indexPending, e: r2.indexError }, { p: true, e: 'EMBEDDING_MISMATCH' });
	assert.equal(fs.readFileSync(abs, 'utf-8'), 'v2');
});
