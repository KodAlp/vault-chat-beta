#!/usr/bin/env node
/**
 * Aşama 3 — `--full` yeniden indekslemeden önce üç gerçek kasanın index.db'sini
 * yedekler. `--full` bu dosyaları silip sıfırdan yazıyor (index-vault.ts), bu
 * yüzden önce WAL-tutarlı bir yedek alınır (fs.copyFileSync değil,
 * better-sqlite3'ün .backup() metodu — WAL modundaki bir DB'yi dosya kopyalamak
 * yarım yazılmış sayfalar verebilir).
 *
 *   node scripts/backup-before-full.mjs
 *
 * Yedekler repo dışına, masaüstüne yazılır — indeksleyici yalnızca .md
 * dosyalarını tarar, ama yine de kasa klasörünün dışında tutmak daha güvenli.
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const VAULTS = ['yapay-zeka', 'default', 'hava-ai'];
const DATA_DIR = process.env.DATA_DIR ?? path.join(process.cwd(), 'data');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupDir = path.join(os.homedir(), 'Desktop', `vault-chat-yedek-${stamp}`);
fs.mkdirSync(backupDir, { recursive: true });

let failed = false;

for (const id of VAULTS) {
	const src = path.join(DATA_DIR, 'vaults', id, 'index.db');
	if (!fs.existsSync(src)) {
		console.log(`atlandı (dosya yok): ${id} -> ${src}`);
		continue;
	}
	const dst = path.join(backupDir, `${id}.index.db`);
	const db = new Database(src, { readonly: true });
	try {
		await db.backup(dst);
		const size = fs.statSync(dst).size;
		console.log(`yedeklendi: ${id} -> ${dst} (${(size / 1024 / 1024).toFixed(1)} MB)`);
	} catch (err) {
		console.error(`YEDEKLEME BAŞARISIZ: ${id}`, err);
		failed = true;
	} finally {
		db.close();
	}
}

console.log(`\nYedek klasörü: ${backupDir}`);
if (failed) {
	console.error('\nEn az bir yedek başarısız oldu — --full çalıştırmadan önce düzelt.');
	process.exit(1);
}
