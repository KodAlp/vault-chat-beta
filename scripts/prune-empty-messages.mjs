// One-time cleanup for chats.db rows written by the pre-Faz-11 bug where
// the SSE route's `finally` block unconditionally persisted an assistant
// message even when retrieval/the provider failed before any content
// streamed in. Safe to run repeatedly — idempotent, since a fixed server
// no longer produces new rows matching this shape.
//
//   node scripts/prune-empty-messages.mjs           # dry run, reports count only
//   node scripts/prune-empty-messages.mjs --apply   # actually deletes
import path from 'node:path';
import Database from 'better-sqlite3';

const isApply = process.argv.includes('--apply');
const dbPath = path.resolve(process.cwd(), process.env.CHATS_DB_PATH ?? path.join('data', 'chats.db'));

const db = new Database(dbPath, { fileMustExist: true });

const MATCH = `role = 'assistant' AND content = '' AND (thinking IS NULL OR thinking = '')`;

const { n } = db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE ${MATCH}`).get();

if (n === 0) {
	console.log('Temizlenecek boş assistant mesajı yok.');
	process.exit(0);
}

if (!isApply) {
	console.log(`${n} boş assistant mesajı bulundu (${dbPath}). Silmek için --apply ile çalıştır.`);
	process.exit(0);
}

const result = db.prepare(`DELETE FROM messages WHERE ${MATCH}`).run();
console.log(`${result.changes} boş assistant mesajı silindi.`);
