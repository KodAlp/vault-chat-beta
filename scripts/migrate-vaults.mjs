// One-time migration from the pre-Faz-8 single-library layout to the
// multi-vault registry (data/vaults.json). Idempotent: if vaults.json
// already exists, this is a no-op. See vault-registry skill.
//
//   node scripts/migrate-vaults.mjs           # perform the migration
//   node scripts/migrate-vaults.mjs --dry-run # report what would move, write nothing
//
// Also invoked automatically (no args) by the server on startup when
// data/vaults.json is missing — see src/hooks.server.ts.
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const isDryRun = process.argv.includes('--dry-run');
const dataDir = path.resolve(process.cwd(), process.env.DATA_DIR ?? 'data');
const registryPath = path.join(dataDir, 'vaults.json');

if (existsSync(registryPath)) {
	console.log('data/vaults.json zaten var — migration atlanıyor (idempotent).');
	process.exit(0);
}

// LIBRARY_PATH only — NEVER VAULT_PATH. LIBRARY_PATH (Faz 5) names a folder
// the app itself owns and writes into, safe to relocate with a rename.
// VAULT_PATH (pre-Faz-5) is a raw pointer at the user's REAL, live-edited
// Obsidian vault, indexed in place and never copied — renaming that would
// mean moving the user's actual personal vault into the app's data folder.
// If only VAULT_PATH was set, the "default" vault starts empty; its content
// was never actually owned by the app and must be (re-)imported via
// Ayarlar → Kütüphane → "Obsidian'dan İçe Aktar", same as any new vault.
const legacyLibrary = process.env.LIBRARY_PATH;
const legacyIndexDb = process.env.INDEX_DB_PATH ?? path.join('data', 'vault-index.db');
const legacyStudyDb = process.env.STUDY_DB_PATH ?? path.join('data', 'study.db');

const libSrc = legacyLibrary ? path.resolve(process.cwd(), legacyLibrary) : undefined;
const indexSrc = path.resolve(process.cwd(), legacyIndexDb);
const studySrc = path.resolve(process.cwd(), legacyStudyDb);

const vaultDir = path.join(dataDir, 'vaults', 'default');
const libDest = path.join(vaultDir, 'library');
const indexDest = path.join(vaultDir, 'index.db');
const studyDest = path.join(vaultDir, 'study.db');

if (!legacyLibrary && process.env.VAULT_PATH) {
	console.log(
		`VAULT_PATH=${process.env.VAULT_PATH} bulundu ama TAŞINMAYACAK (canlı Obsidian vault'u,\n` +
			`app'e ait değil) — "default" vault boş kütüphaneyle başlar. İçerik gerekirse\n` +
			`Ayarlar → Kütüphane → "Obsidian'dan İçe Aktar" ile elle (yeniden) içe aktarılmalı.`
	);
}
console.log(`Kaynak kütüphane : ${libSrc ?? '(LIBRARY_PATH yok — boş başlar)'} ${libSrc && existsSync(libSrc) ? '' : libSrc ? '(yok)' : ''}`);
console.log(`Kaynak indeks    : ${indexSrc} ${existsSync(indexSrc) ? '' : '(yok)'}`);
console.log(`Kaynak study db  : ${studySrc} ${existsSync(studySrc) ? '' : '(yok)'}`);
console.log(`Hedef            : ${vaultDir}`);

if (isDryRun) {
	console.log('(dry-run — hiçbir şey taşınmadı/yazılmadı)');
	process.exit(0);
}

mkdirSync(vaultDir, { recursive: true });

/**
 * Same-disk fs.renameSync is a single atomic rename, not the recursive
 * directory walk that cpSync/rmSync hit Windows-specific EIO/EBUSY
 * failures on for this repo's non-ASCII path (documented in Faz 7 and the
 * vault-registry skill) — so it's tried first. The robocopy/PowerShell
 * fallback only exists for the unlikely case renameSync itself fails (e.g.
 * a cross-device move if DATA_DIR ever points at a different drive).
 */
function moveDir(src, dest) {
	if (!src || !existsSync(src)) {
		mkdirSync(dest, { recursive: true });
		return;
	}
	try {
		renameSync(src, dest);
		return;
	} catch (err) {
		console.warn(`renameSync başarısız (${err.message}), robocopy'ye düşülüyor...`);
	}
	mkdirSync(dest, { recursive: true });
	try {
		execFileSync('robocopy', [src, dest, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NC', '/NS'], {
			stdio: 'inherit'
		});
	} catch (err) {
		if ((err.status ?? 0) >= 8) throw err;
	}
	execFileSync('powershell', ['-NoProfile', '-Command', `Remove-Item -Path "${src}" -Recurse -Force`], {
		stdio: 'inherit'
	});
}

function moveFileWithWal(srcBase, destBase) {
	for (const suffix of ['', '-wal', '-shm']) {
		const src = `${srcBase}${suffix}`;
		const dest = `${destBase}${suffix}`;
		if (existsSync(src)) renameSync(src, dest);
	}
}

moveDir(libSrc, libDest);
moveFileWithWal(indexSrc, indexDest);
moveFileWithWal(studySrc, studyDest);

const now = new Date().toISOString();
const vaultName = process.env.PUBLIC_VAULT_NAME?.trim() || 'Kütüphane';
const registry = {
	vaults: [
		{
			id: 'default',
			name: vaultName,
			path: libDest,
			createdAt: now,
			lastOpenedAt: now
		}
	],
	activeVaultId: 'default'
};
writeFileSync(registryPath, JSON.stringify(registry, null, 2), 'utf-8');

console.log('Migration tamamlandı: "default" vault kaydedildi.');
console.log(
	'chats.db\'deki eski sohbetler otomatik olarak vault_id=\'default\' alır (ilk açılışta ALTER TABLE ... DEFAULT).'
);
