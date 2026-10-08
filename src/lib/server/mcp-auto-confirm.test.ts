import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import matter from 'gray-matter';
import { createVault, contextFor, setVaultMcpExposed, setVaultMcpAutoConfirm, getVaultMcpAutoConfirm, listVaults, type VaultContext } from './vaults';
import { stagingDir, importLogPath } from './library';
import { writeMeta, readMeta, type PendingImportMeta } from './pending-imports';
import { confirmStagedImport } from './import-confirm';
import { autoConfirmIfEligible, listRecentlyConfirmed, AUTO_CONFIRM_FAILED, RECENT_TTL_MS } from './mcp-auto-confirm';
import { AppError } from './app-error';

/**
 * Everything runs in a throwaway DATA_DIR with real (temp) vaults; the indexer is
 * stubbed because a real one needs an embedding backend, and the contract under
 * test is the file / sidecar / log effects plus the mode decision. One top-level
 * test with sequential subtests because DATA_DIR is process-global.
 */
function freshVault(): VaultContext {
	process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-confirm-test-'));
	return contextFor(createVault('Deneme'));
}

function stage(v: VaultContext, over: Partial<PendingImportMeta> = {}, fm: Record<string, unknown> = {}): PendingImportMeta {
	const now = new Date().toISOString();
	const meta: PendingImportMeta = {
		importId: crypto.randomUUID(),
		status: 'ready',
		source: { kind: 'url', name: 'example.org' },
		proposed: { title: 'Lineer Cebir', domain: 'matematik', level: 'undergraduate' },
		warnings: [],
		by: 'mcp',
		createdAt: now,
		updatedAt: now,
		...over
	};
	fs.mkdirSync(stagingDir(v), { recursive: true });
	fs.writeFileSync(
		path.join(stagingDir(v), `${meta.importId}.md`),
		matter.stringify('# Baslik\n\nIcerik.\n', { source_url: 'https://example.org/a', converted_by: 'test', ...fm }),
		'utf-8'
	);
	writeMeta(v, meta);
	return meta;
}

const staged = (v: VaultContext, id: string) => path.join(stagingDir(v), `${id}.md`);
const logLines = (v: VaultContext) =>
	fs.existsSync(importLogPath(v))
		? fs
				.readFileSync(importLogPath(v), 'utf-8')
				.split('\n')
				.filter(Boolean)
				.map((l) => JSON.parse(l) as Record<string, unknown>)
		: [];
const okIndexer = async () => {};
const failingIndexer = async () => {
	throw new Error('index boom');
};

test('mcp auto-confirm', async (t) => {
	await t.test('setting: strict validation, needs an exposed vault, closing MCP withdraws it', () => {
		const v = freshVault();
		assert.equal(getVaultMcpAutoConfirm(v.id), 'off');
		// Closed vault: refusing any non-off mode.
		assert.throws(() => setVaultMcpAutoConfirm(v.id, 'all'), (e) => e instanceof AppError && e.code === 'MCP_VAULT_NOT_EXPOSED');
		setVaultMcpExposed(v.id, true);
		for (const bad of ['ALL', '', 'yes', true, 1, null, undefined, ['all']]) {
			assert.throws(() => setVaultMcpAutoConfirm(v.id, bad), (e) => e instanceof AppError && e.code === 'VALIDATION_INVALID', String(bad));
		}
		setVaultMcpAutoConfirm(v.id, 'clean');
		assert.equal(getVaultMcpAutoConfirm(v.id), 'clean');
		setVaultMcpAutoConfirm(v.id, 'all');
		assert.equal(getVaultMcpAutoConfirm(v.id), 'all');
		setVaultMcpExposed(v.id, false);
		assert.equal(getVaultMcpAutoConfirm(v.id), 'off');
		setVaultMcpExposed(v.id, true);
		assert.equal(getVaultMcpAutoConfirm(v.id), 'off', 're-opening must not resume the old instruction');
		assert.throws(() => setVaultMcpAutoConfirm('yok-boyle-bir-vault', 'off'));
	});

	await t.test('setting: a tampered stored value reads as off', () => {
		const v = freshVault();
		setVaultMcpExposed(v.id, true);
		const reg = path.join(process.env.DATA_DIR as string, 'vaults.json');
		const parsed = JSON.parse(fs.readFileSync(reg, 'utf-8'));
		parsed.vaults[0].mcpAutoConfirm = 'everything';
		fs.writeFileSync(reg, JSON.stringify(parsed));
		assert.equal(getVaultMcpAutoConfirm(v.id), 'off');
		assert.equal(listVaults()[0].mcpAutoConfirm, 'everything' as never); // stored as-is, ignored on read
	});

	await t.test('confirmStagedImport: manual confirm writes the note, the log (no autoConfirmed) and cleans staging', async () => {
		const v = freshVault();
		const m = stage(v);
		const res = await confirmStagedImport(v, m.importId, { title: 'Lineer Cebir', domain: 'matematik', level: 'graduate' }, { indexer: okIndexer });
		assert.match(res.path, /^matematik\/.+\.md$/);
		const note = matter(fs.readFileSync(path.join(v.libraryRoot, res.path), 'utf-8'));
		assert.equal(note.data.title, 'Lineer Cebir');
		assert.equal(note.data.domain, 'matematik');
		assert.equal(note.data.level, 'graduate');
		assert.equal(fs.existsSync(staged(v, m.importId)), false);
		assert.equal(readMeta(v, m.importId), null);
		const [entry] = logLines(v);
		assert.equal(entry.status, 'converted');
		assert.equal(entry.by, 'mcp');
		assert.equal('autoConfirmed' in entry, false);
	});

	await t.test('confirmStagedImport: expired / invalid id', async () => {
		const v = freshVault();
		await assert.rejects(confirmStagedImport(v, crypto.randomUUID(), { title: 'a', domain: 'b' }, { indexer: okIndexer }), (e) => e instanceof AppError && e.code === 'IMPORT_EXPIRED');
		await assert.rejects(confirmStagedImport(v, '../x', { title: 'a', domain: 'b' }, { indexer: okIndexer }), (e) => e instanceof AppError && e.code === 'VALIDATION_INVALID');
	});

	await t.test('auto-confirm happy path (clean): lands in the library, logged as mcp + autoConfirmed, recorded for the agent', async () => {
		const v = freshVault();
		const m = stage(v);
		const out = await autoConfirmIfEligible(v, m.importId, { mode: 'clean', indexer: okIndexer });
		assert.equal(out.kind, 'confirmed');
		const rel = (out as { path: string }).path;
		assert.ok(fs.existsSync(path.join(v.libraryRoot, rel)));
		assert.equal(fs.existsSync(staged(v, m.importId)), false);
		assert.equal(readMeta(v, m.importId), null);
		const [entry] = logLines(v);
		assert.equal(entry.by, 'mcp');
		assert.equal(entry.autoConfirmed, true);
		assert.equal(entry.status, 'converted');
		const recent = listRecentlyConfirmed(v);
		assert.equal(recent.length, 1);
		assert.equal(recent[0].importId, m.importId);
		assert.equal(recent[0].path, rel);
		// Entries expire.
		assert.deepEqual(listRecentlyConfirmed(v, Date.now() + RECENT_TTL_MS + 1000), []);
	});

	await t.test('clean mode leaves warned / needs_review / duplicate imports pending', async () => {
		const v = freshVault();
		const withWarning = stage(v, { warnings: ['IMPORT_DUPLICATE_CONTENT'] });
		const reviewed = stage(v, {}, { needs_review: true });
		for (const m of [withWarning, reviewed]) {
			const out = await autoConfirmIfEligible(v, m.importId, { mode: 'clean', indexer: okIndexer });
			assert.equal(out.kind, 'skipped');
			assert.ok(fs.existsSync(staged(v, m.importId)));
			assert.ok(readMeta(v, m.importId));
		}
		assert.deepEqual(logLines(v), []);
	});

	await t.test('all mode confirms warned and needs_review imports', async () => {
		const v = freshVault();
		const a = stage(v, { warnings: ['IMPORT_DUPLICATE_CONTENT'] });
		const b = stage(v, { proposed: { title: 'Baska', domain: 'matematik', level: 'undergraduate' } }, { needs_review: true });
		assert.equal((await autoConfirmIfEligible(v, a.importId, { mode: 'all', indexer: okIndexer })).kind, 'confirmed');
		assert.equal((await autoConfirmIfEligible(v, b.importId, { mode: 'all', indexer: okIndexer })).kind, 'confirmed');
		assert.equal(logLines(v).length, 2);
	});

	await t.test('off mode, app-made imports and error states are never confirmed', async () => {
		const v = freshVault();
		const off = stage(v);
		const app = stage(v, { by: 'app' });
		const errored = stage(v, { status: 'error', error: { code: 'CONVERSION_EMPTY' } });
		assert.equal((await autoConfirmIfEligible(v, off.importId, { mode: 'off', indexer: okIndexer })).kind, 'skipped');
		assert.equal((await autoConfirmIfEligible(v, app.importId, { mode: 'all', indexer: okIndexer })).kind, 'skipped');
		assert.equal((await autoConfirmIfEligible(v, errored.importId, { mode: 'all', indexer: okIndexer })).kind, 'skipped');
		assert.deepEqual(logLines(v), []);
		for (const m of [off, app, errored]) assert.ok(fs.existsSync(staged(v, m.importId)));
	});

	await t.test('index failure rolls back: note removed, staged note restored, coded warning, nothing recorded as confirmed', async () => {
		const v = freshVault();
		const m = stage(v);
		const original = fs.readFileSync(staged(v, m.importId), 'utf-8');
		const out = await autoConfirmIfEligible(v, m.importId, { mode: 'all', indexer: failingIndexer });
		assert.equal(out.kind, 'failed');
		assert.equal((out as { code: string }).code, 'IMPORT_INDEX_FAILED');
		assert.equal(fs.readFileSync(staged(v, m.importId), 'utf-8'), original);
		assert.equal(fs.existsSync(path.join(v.libraryRoot, 'matematik')) && fs.readdirSync(path.join(v.libraryRoot, 'matematik')).length > 0, false);
		const meta = readMeta(v, m.importId);
		assert.equal(meta?.status, 'ready');
		assert.ok(meta?.warnings.includes(AUTO_CONFIRM_FAILED));
		assert.deepEqual(listRecentlyConfirmed(v), []);
		const [entry] = logLines(v);
		assert.equal(entry.status, 'indekslenmedi');
		assert.equal(entry.autoConfirmed, true);
		// A second attempt does not pile up duplicate warnings, and the user can still confirm manually.
		await autoConfirmIfEligible(v, m.importId, { mode: 'all', indexer: failingIndexer });
		assert.equal(readMeta(v, m.importId)?.warnings.filter((w) => w === AUTO_CONFIRM_FAILED).length, 1);
		const res = await confirmStagedImport(v, m.importId, { title: 'Lineer Cebir', domain: 'matematik' }, { indexer: okIndexer });
		assert.ok(fs.existsSync(path.join(v.libraryRoot, res.path)));
	});
});
