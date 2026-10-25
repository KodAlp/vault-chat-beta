// One-time migration from the pre-multi-vault single-library layout to the
// multi-vault registry (data/vaults.json). Idempotent: if vaults.json
// already exists, this is a no-op.
//
//   node scripts/migrate-vaults.mjs           # perform the migration
//   node scripts/migrate-vaults.mjs --dry-run # report what would move, write nothing
//
// Also invoked automatically (no args) by the server on startup when
// data/vaults.json is missing — see src/hooks.server.ts.
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const isDryRun = process.argv.includes('--dry-run');
const dataDir = path.resolve(process.cwd(), process.env.DATA_DIR ?? 'data');
const registryPath = path.join(dataDir, 'vaults.json');

if (existsSync(registryPath)) {
	console.log('data/vaults.json zaten var — migration atlanıyor (idempotent).');
	process.exit(0);
}

// LIBRARY_PATH only — NEVER VAULT_PATH. LIBRARY_PATH names a folder
// the app itself owns and writes into, safe to relocate with a rename.
// VAULT_PATH (older layout) is a raw pointer at the user's REAL, live-edited
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

/** Relative path (posix separators) -> size for every file under dir. */
function listTree(dir) {
	const out = new Map();
	const walk = (cur, rel) => {
		for (const entry of readdirSync(cur, { withFileTypes: true })) {
			const abs = path.join(cur, entry.name);
			const r = rel ? `${rel}/${entry.name}` : entry.name;
			if (entry.isDirectory()) walk(abs, r);
			else out.set(r, statSync(abs).size);
		}
	};
	walk(dir, '');
	return out;
}

function diffTrees(src, dest) {
	const problems = [];
	for (const [rel, size] of src) {
		if (!dest.has(rel)) problems.push(`eksik: ${rel}`);
		else if (dest.get(rel) !== size) problems.push(`boyut farklı: ${rel}`);
	}
	for (const rel of dest.keys()) if (!src.has(rel)) problems.push(`fazla: ${rel}`);
	return problems;
}

function copyTree(src, dest) {
	if (process.platform === 'win32') {
		const r = spawnSync('robocopy', [src, dest, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NC', '/NS'], {
			stdio: 'inherit'
		});
		// 0-7 = success; >=8 = failure; null status (spawn failed, e.g. ENOENT) = failure too.
		if (r.error || r.status === null || r.status >= 8) {
			throw new Error(`robocopy başarısız (status=${r.status}${r.error ? `, ${r.error.message}` : ''})`);
		}
		return;
	}
	cpSync(src, dest, { recursive: true, errorOnExist: true, force: false });
}

/**
 * Same-disk fs.renameSync is a single atomic rename, not the recursive
 * directory walk that cpSync/rmSync hit Windows-specific EIO/EBUSY
 * failures on for this repo's non-ASCII path — so it's tried first. The copy fallback (robocopy
 * on Windows, fs.cpSync elsewhere) only exists for the case renameSync itself
 * fails (e.g. EXDEV when DATA_DIR is on a different filesystem). The copy is
 * verified (same relative files + sizes) BEFORE the source is deleted; on any
 * failure the source is left intact and the script aborts. Mirrors
 * src/lib/server/moveDirSafe.ts (kept as a copy: this script runs standalone).
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
		console.warn(`renameSync başarısız (${err.message}), kopyalamaya düşülüyor...`);
	}
	mkdirSync(dest, { recursive: true });
	try {
		copyTree(src, dest);
	} catch (err) {
		throw new Error(`[MIGRATE_COPY_FAILED] ${src} -> ${dest} kopyalanamadı; kaynak silinmedi: ${err.message}`);
	}
	const problems = diffTrees(listTree(src), listTree(dest));
	if (problems.length > 0) {
		throw new Error(
			`[MIGRATE_COPY_VERIFY_FAILED] kopya kaynakla eşleşmiyor (${problems.slice(0, 5).join('; ')}); kaynak silinmedi`
		);
	}
	// fs.rmSync, no shell involved (replaced an injectable PowerShell Remove-Item).
	rmSync(src, { recursive: true, force: true });
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
