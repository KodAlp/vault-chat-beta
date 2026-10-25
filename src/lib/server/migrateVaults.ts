import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { moveDirSafe } from './moveDirSafe';

/**
 * Server-startup counterpart to scripts/migrate-vaults.mjs — same migration,
 * duplicated here (not imported) because this module ships inside build/
 * and runs on every server start, including the packaged Tauri app where
 * scripts/ is never bundled (see stage-server.mjs — only build/,
 * package.json, and data/providers.json get staged into dist-server/). The
 * standalone script stays for manual/--dry-run CLI use during development.
 * See vault-registry skill.
 */
function moveDir(src: string | undefined, dest: string): void {
	moveDirSafe(src, dest);
}

function moveFileWithWal(srcBase: string, destBase: string): void {
	for (const suffix of ['', '-wal', '-shm']) {
		const src = `${srcBase}${suffix}`;
		const dest = `${destBase}${suffix}`;
		if (existsSync(src)) renameSync(src, dest);
	}
}

/**
 * No-op if data/vaults.json already exists. Reads the same legacy env vars
 * the pre-vault-registry code did, so an upgrade from an older build (or a first
 * Tauri launch after the upgrade) migrates automatically with no user
 * action — EXCEPT VAULT_PATH, deliberately never used as a move source: it
 * points at the user's real, live-edited Obsidian vault (before the app-owned library folder, indexed
 * in place, never copied), not app-owned content. Renaming that into
 * data/vaults/default/ would relocate the user's actual personal vault.
 * Only LIBRARY_PATH (an app-owned folder) is safe to move; if unset,
 * "default" starts with an empty library regardless of VAULT_PATH — its
 * content must be (re-)imported via the Kütüphane "Obsidian'dan İçe Aktar"
 * flow, same as any new vault.
 */
export function runVaultMigrationIfNeeded(): void {
	const dataDir = path.resolve(process.cwd(), process.env.DATA_DIR ?? 'data');
	const registryPath = path.join(dataDir, 'vaults.json');
	if (existsSync(registryPath)) return;

	const legacyLibrary = process.env.LIBRARY_PATH;
	const legacyIndexDb = process.env.INDEX_DB_PATH ?? path.join('data', 'vault-index.db');
	const legacyStudyDb = process.env.STUDY_DB_PATH ?? path.join('data', 'study.db');

	const libSrc = legacyLibrary ? path.resolve(process.cwd(), legacyLibrary) : undefined;
	const indexSrc = path.resolve(process.cwd(), legacyIndexDb);
	const studySrc = path.resolve(process.cwd(), legacyStudyDb);

	if (!legacyLibrary && process.env.VAULT_PATH) {
		console.log(
			`[vault-migration] VAULT_PATH=${process.env.VAULT_PATH} bulundu ama taşınmıyor ` +
				`(canlı Obsidian vault'u, app'e ait değil) — "default" vault boş başlar.`
		);
	}

	const vaultDir = path.join(dataDir, 'vaults', 'default');

	mkdirSync(vaultDir, { recursive: true });
	moveDir(libSrc, path.join(vaultDir, 'library'));
	moveFileWithWal(indexSrc, path.join(vaultDir, 'index.db'));
	moveFileWithWal(studySrc, path.join(vaultDir, 'study.db'));

	const now = new Date().toISOString();
	const vaultName = process.env.PUBLIC_VAULT_NAME?.trim() || 'Kütüphane';
	writeFileSync(
		registryPath,
		JSON.stringify(
			{
				vaults: [
					{
						id: 'default',
						name: vaultName,
						path: path.join(vaultDir, 'library'),
						createdAt: now,
						lastOpenedAt: now
					}
				],
				activeVaultId: 'default'
			},
			null,
			2
		),
		'utf-8'
	);
	console.log(`[vault-migration] "default" vault oluşturuldu (${vaultDir})`);
}
