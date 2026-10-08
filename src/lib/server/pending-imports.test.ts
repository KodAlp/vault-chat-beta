import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
	writeMeta,
	readMeta,
	updateMeta,
	deleteMeta,
	listPending,
	markImportActive,
	markImportInactive,
	IMPORT_ID_RE,
	type PendingImportMeta
} from './pending-imports';
import type { VaultContext } from './vaults';

function tmpVault(): VaultContext {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pending-imports-test-'));
	const libraryRoot = path.join(dir, 'library');
	fs.mkdirSync(libraryRoot, { recursive: true });
	return { id: 't', name: 't', dir, libraryRoot, indexDbPath: path.join(dir, 'index.db'), studyDbPath: path.join(dir, 'study.db') };
}

function staging(v: VaultContext): string {
	const d = path.join(v.libraryRoot, '_meta', 'staging');
	fs.mkdirSync(d, { recursive: true });
	return d;
}

function meta(over: Partial<PendingImportMeta> = {}): PendingImportMeta {
	const now = new Date().toISOString();
	return {
		importId: crypto.randomUUID(),
		status: 'ready',
		source: { kind: 'path', name: 'sema.pdf' },
		proposed: { title: 'Sema', domain: 'genel', level: 'undergraduate' },
		warnings: [],
		by: 'mcp',
		createdAt: now,
		updatedAt: now,
		...over
	};
}

test('writeMeta/readMeta round-trip, no tmp file left behind', () => {
	const v = tmpVault();
	const m = meta();
	writeMeta(v, m);
	assert.deepEqual(readMeta(v, m.importId), m);
	assert.deepEqual(fs.readdirSync(staging(v)), [`${m.importId}.json`]);
});

test('readMeta rejects non-uuid ids and corrupt files', () => {
	const v = tmpVault();
	assert.equal(readMeta(v, '../../etc/passwd'), null);
	const id = crypto.randomUUID();
	fs.writeFileSync(path.join(staging(v), `${id}.json`), '{bad');
	assert.equal(readMeta(v, id), null);
	fs.writeFileSync(path.join(staging(v), `${id}.json`), JSON.stringify({ importId: id, status: 'weird' }));
	assert.equal(readMeta(v, id), null);
});

test('writeMeta refuses an id that is not a uuid', () => {
	const v = tmpVault();
	assert.throws(() => writeMeta(v, meta({ importId: '../x' })));
});

test('updateMeta merges, bumps updatedAt, and does not resurrect a deleted meta', () => {
	const v = tmpVault();
	const m = meta({ status: 'queued', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' });
	writeMeta(v, m);
	const next = updateMeta(v, m.importId, { status: 'converting' });
	assert.equal(next?.status, 'converting');
	assert.equal(next?.createdAt, m.createdAt);
	assert.notEqual(next?.updatedAt, m.updatedAt);
	deleteMeta(v, m.importId);
	assert.equal(updateMeta(v, m.importId, { status: 'ready' }), null);
	assert.equal(readMeta(v, m.importId), null);
});

test('listPending merges meta+md, shows an orphan .md as ready/app with frontmatter title, newest first', async () => {
	const v = tmpVault();
	const dir = staging(v);

	const ready = meta({ createdAt: '2026-10-01T10:00:00.000Z' });
	writeMeta(v, ready);
	fs.writeFileSync(path.join(dir, `${ready.importId}.md`), '---\ntitle: Sema\n---\n\nbody');

	const orphanId = crypto.randomUUID();
	fs.writeFileSync(path.join(dir, `${orphanId}.md`), '---\ntitle: Elle Yüklenen\ndomain: fizik\nlevel: grad\n---\n\nbody');

	const untitledId = crypto.randomUUID();
	fs.writeFileSync(path.join(dir, `${untitledId}.md`), 'no frontmatter');

	const errored = meta({ status: 'error', error: { code: 'CONVERSION_EMPTY' }, createdAt: '2026-10-03T10:00:00.000Z' });
	writeMeta(v, errored);

	// noise that must be ignored: a work dir, a tmp file, a non-uuid file
	fs.mkdirSync(path.join(dir, crypto.randomUUID()));
	fs.writeFileSync(path.join(dir, `${crypto.randomUUID()}.json.123.tmp`), '{}');
	fs.writeFileSync(path.join(dir, 'notes.md'), 'x');

	const list = listPending(v);
	assert.equal(list.length, 4);
	const byId = new Map(list.map((m) => [m.importId, m]));
	assert.equal(byId.get(ready.importId)?.by, 'mcp');
	assert.equal(byId.get(errored.importId)?.status, 'error');
	const orphan = byId.get(orphanId);
	assert.equal(orphan?.status, 'ready');
	assert.equal(orphan?.by, 'app');
	assert.deepEqual(orphan?.proposed, { title: 'Elle Yüklenen', domain: 'fizik', level: 'grad' });
	assert.equal(byId.get(untitledId)?.proposed.title, 'Adsız');
	// orphans carry the file mtime (now), so they sort ahead of the 2026-10 fixtures
	assert.deepEqual(
		list.map((m) => m.createdAt),
		[...list.map((m) => m.createdAt)].sort().reverse()
	);
});

test('a ready meta whose note is gone is not listed; an error meta without a note is', () => {
	const v = tmpVault();
	staging(v);
	writeMeta(v, meta({ status: 'ready' }));
	const err = meta({ status: 'error', error: { code: 'LINK_TIMEOUT' } });
	writeMeta(v, err);
	assert.deepEqual(listPending(v).map((m) => m.importId), [err.importId]);
});

test('queued/converting metas nobody is working on are reported as interrupted errors', () => {
	const v = tmpVault();
	const stale = meta({ status: 'converting' });
	const live = meta({ status: 'queued' });
	writeMeta(v, stale);
	writeMeta(v, live);
	markImportActive(live.importId);
	try {
		const byId = new Map(listPending(v).map((m) => [m.importId, m]));
		assert.equal(byId.get(stale.importId)?.status, 'error');
		assert.equal(byId.get(stale.importId)?.error?.code, 'IMPORT_INTERRUPTED');
		assert.equal(byId.get(live.importId)?.status, 'queued');
	} finally {
		markImportInactive(live.importId);
	}
});

test('an empty or missing staging dir lists nothing', () => {
	assert.deepEqual(listPending(tmpVault()), []);
});

test('IMPORT_ID_RE accepts a randomUUID and rejects anything that could escape the staging folder', () => {
	assert.ok(IMPORT_ID_RE.test(crypto.randomUUID()));
	for (const bad of ['', '..', '../../x', '..\\..\\x','a/b', crypto.randomUUID() + '/..', crypto.randomUUID() + '.md', ' ' + crypto.randomUUID()]) {
		assert.equal(IMPORT_ID_RE.test(bad), false, bad);
	}
});
