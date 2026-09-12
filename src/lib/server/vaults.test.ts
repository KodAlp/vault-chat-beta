import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
	createVault,
	renameVault,
	deleteVault,
	listVaults,
	getActiveVaultId,
	resolveVault,
	hasAnyVault,
	contextFor,
	markVaultUsed,
	markVaultSynced,
	setActiveVault
} from './vaults';

/**
 * vaults.ts has no module-level singleton — every function re-reads
 * process.env.DATA_DIR on each call — so isolating a test only requires
 * pointing DATA_DIR at a fresh temp dir before calling anything. But
 * process.env is a single shared global: Node's test runner does NOT
 * guarantee top-level test() calls run one-at-a-time, so sibling tests
 * setting DATA_DIR concurrently would race. Nesting everything under one
 * top-level test with `await t.test(...)` for each case forces sequential
 * execution (each subtest's promise is awaited before the next starts).
 */
function useTmpDataDir(): void {
	process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-registry-test-'));
}

test('vault registry', async (t) => {
	await t.test('createVault registers a slugified id and creates the library folder', () => {
		useTmpDataDir();
		const record = createVault('Matematik');
		assert.equal(record.id, 'matematik');
		assert.equal(record.name, 'Matematik');
		assert.ok(fs.existsSync(contextFor(record).libraryRoot));
		assert.equal(listVaults().length, 1);
	});

	await t.test('createVault de-duplicates slugs with a numeric suffix', () => {
		useTmpDataDir();
		const a = createVault('Fizik');
		const b = createVault('Fizik');
		assert.equal(a.id, 'fizik');
		assert.equal(b.id, 'fizik-2');
	});

	await t.test('first created vault becomes active automatically', () => {
		useTmpDataDir();
		const record = createVault('Kimya');
		assert.equal(getActiveVaultId(), record.id);
	});

	await t.test('renameVault changes name but keeps id stable', () => {
		useTmpDataDir();
		const record = createVault('Eski Ad');
		const renamed = renameVault(record.id, 'Yeni Ad');
		assert.equal(renamed.id, record.id);
		assert.equal(renamed.name, 'Yeni Ad');
	});

	await t.test('resolveVault throws on an unknown id', () => {
		useTmpDataDir();
		assert.throws(() => resolveVault('does-not-exist'));
	});

	await t.test('resolveVault falls back to the active vault when id is omitted', () => {
		useTmpDataDir();
		const record = createVault('Aktif');
		const ctx = resolveVault();
		assert.equal(ctx.id, record.id);
	});

	await t.test('deleting the active vault hands activeVaultId to another remaining vault', () => {
		useTmpDataDir();
		const a = createVault('A');
		const b = createVault('B');
		deleteVault(a.id);
		assert.equal(getActiveVaultId(), b.id);
	});

	await t.test('deleteVault removes the vault folder from disk', () => {
		useTmpDataDir();
		const record = createVault('Silinecek');
		const vaultDir = contextFor(record).dir;
		assert.ok(fs.existsSync(vaultDir));
		deleteVault(record.id);
		assert.ok(!fs.existsSync(vaultDir));
	});

	await t.test('a corrupt registry file is treated as empty, not thrown', () => {
		useTmpDataDir();
		fs.writeFileSync(path.join(process.env.DATA_DIR!, 'vaults.json'), '{ not valid json', 'utf-8');
		assert.deepEqual(listVaults(), []);
		assert.equal(getActiveVaultId(), null);
	});

	await t.test('hasAnyVault reflects registry state', () => {
		useTmpDataDir();
		assert.equal(hasAnyVault(), false);
		createVault('Bir Şey');
		assert.equal(hasAnyVault(), true);
	});

	await t.test('markVaultUsed sets active id and lastOpenedAt in one write', () => {
		useTmpDataDir();
		const first = createVault('İlk');
		const second = createVault('İkinci');
		setActiveVault(first.id);

		const before = listVaults().find((v) => v.id === second.id)!.lastOpenedAt;
		markVaultUsed(second.id);

		assert.equal(getActiveVaultId(), second.id);
		const after = listVaults().find((v) => v.id === second.id)!.lastOpenedAt;
		assert.notEqual(after, before);
		// The other vault is left alone — this marks one vault as used, it does
		// not rewrite the rest of the registry.
		assert.equal(
			listVaults().find((v) => v.id === first.id)!.name,
			'İlk'
		);
	});

	await t.test('markVaultUsed rejects an unknown vault instead of silently doing nothing', () => {
		useTmpDataDir();
		createVault('Var Olan');
		assert.throws(() => markVaultUsed('yok-boyle-bir-vault'));
	});

	await t.test('markVaultSynced sets lastSyncedAt without touching lastOpenedAt or the active vault', () => {
		useTmpDataDir();
		const first = createVault('Birinci');
		const second = createVault('İkinci');
		setActiveVault(first.id);
		const openedBefore = listVaults().find((v) => v.id === second.id)!.lastOpenedAt;

		assert.equal(listVaults().find((v) => v.id === second.id)!.lastSyncedAt, undefined);
		markVaultSynced(second.id);

		const record = listVaults().find((v) => v.id === second.id)!;
		assert.ok(record.lastSyncedAt);
		assert.equal(record.lastOpenedAt, openedBefore); // sync isn't "opening" the vault
		assert.equal(getActiveVaultId(), first.id); // sync doesn't switch the active vault either
	});

	await t.test('markVaultSynced rejects an unknown vault instead of silently doing nothing', () => {
		useTmpDataDir();
		createVault('Var Olan');
		assert.throws(() => markVaultSynced('yok-boyle-bir-vault'));
	});

	await t.test('writeRegistry leaves no .tmp file behind on success', () => {
		useTmpDataDir();
		const v = createVault('Temiz');
		markVaultUsed(v.id);
		const strays = fs.readdirSync(process.env.DATA_DIR!).filter((f) => f.endsWith('.tmp'));
		assert.deepEqual(strays, []);
	});
});
