import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { chatsDbPath } from './env';
import { ensureColumns } from './sqlite-schema';
import { logAppEvent } from './app-log';

export interface ChatRow {
	id: string;
	title: string | null;
	model: string;
	vault_id: string;
	included_paths_json: string | null;
	created_at: string;
	updated_at: string;
}

export interface MessageRow {
	id: string;
	chat_id: string;
	role: 'user' | 'assistant';
	content: string;
	thinking: string | null;
	sources_json: string | null;
	created_at: string;
}

let db: Database.Database | undefined;

/**
 * Split out from getDb() so it's testable against a bare Database instance
 * without going through the module-level singleton — see chats-db.test.ts.
 *
 * Ordering matters here: `CREATE INDEX ... ON chats(vault_id)` must run
 * strictly AFTER the vault_id ALTER-guard below, never bundled into the
 * same exec() as `CREATE TABLE IF NOT EXISTS chats`. On a DB where `chats`
 * already exists without `vault_id` (a pre-Faz-8 DB, or one that reached
 * this function before scripts/migrate-vaults.mjs ran), CREATE TABLE IF
 * NOT EXISTS no-ops — the column is never added by it — so an index on
 * that column created in the same breath fails immediately with "no such
 * column: vault_id", before the guard ever gets a chance to run. This
 * exact bug shipped in Faz 8 and only surfaced once a real vault_id-less
 * chats.db reached it. See sqlite-schema.ts's doc comment for the general
 * rule this is an instance of.
 */
export function initChatsSchema(instance: Database.Database): void {
	instance.pragma('journal_mode = WAL');
	instance.exec(`
		CREATE TABLE IF NOT EXISTS chats (
			id TEXT PRIMARY KEY,
			title TEXT,
			model TEXT NOT NULL,
			vault_id TEXT NOT NULL DEFAULT 'default',
			included_paths_json TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS messages (
			id TEXT PRIMARY KEY,
			chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
			role TEXT NOT NULL,
			content TEXT NOT NULL,
			thinking TEXT,
			sources_json TEXT,
			created_at TEXT NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON messages(chat_id);
	`);
	// vault_id/included_paths_json didn't exist before Faz 8 — a DB created
	// by an older build won't have them yet. scripts/migrate-vaults.mjs
	// handles the real one-time backfill (vault_id='default' for existing
	// rows); this ALTER only guards a pre-Faz-8 DB that reaches getDb()
	// before migration has run, so CREATE TABLE's DEFAULT can't help
	// (defaults only apply to rows inserted after the column exists).
	ensureColumns(instance, 'chats', {
		vault_id: `TEXT NOT NULL DEFAULT 'default'`,
		included_paths_json: 'TEXT'
	});
	// Only safe now that vault_id is guaranteed to exist, regardless of
	// whether `chats` was just created or already existed.
	instance.exec(`CREATE INDEX IF NOT EXISTS idx_chats_vault_id ON chats(vault_id);`);
}

/** Separate from data/vaults/<id>/index.db on purpose — this is user
 * history, the index is regenerable vault content. `npm run index --full`
 * must never touch it. Stays a single global DB (not one per vault) with a
 * vault_id column — see vault-registry skill for why: sohbetler ileride
 * vault-üstü bir "son konuşmalar" görünümü isteyebilir. */
function getDb(): Database.Database {
	if (db) return db;
	const dbPath = chatsDbPath();
	fs.mkdirSync(path.dirname(dbPath), { recursive: true });
	const instance = new Database(dbPath);
	// A pragma/exec failure here must not leave an open handle uncached —
	// nothing would ever close it, and Windows refuses to rename/delete a
	// file with an open handle (the exact EBUSY class Faz 8 hit).
	try {
		initChatsSchema(instance);
	} catch (err) {
		instance.close();
		const message = err instanceof Error ? err.message : 'Bilinmeyen hata';
		logAppEvent({ kind: 'db_error', message: `chats.db init başarısız: ${message}` });
		throw err;
	}
	db = instance;
	return db;
}

/**
 * Id is supplied by the caller, not generated here — the client generates it
 * (crypto.randomUUID(), same convention as ChatMessage.id) so the welcome
 * screen can navigate to /chat/{id} before the first message is even sent.
 */
export function createChat(id: string, model: string, vaultId: string): ChatRow {
	const now = new Date().toISOString();
	const chat: ChatRow = {
		id,
		title: null,
		model,
		vault_id: vaultId,
		included_paths_json: null,
		created_at: now,
		updated_at: now
	};
	getDb()
		.prepare(
			`INSERT INTO chats (id, title, model, vault_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
		)
		.run(chat.id, chat.title, chat.model, chat.vault_id, chat.created_at, chat.updated_at);
	return chat;
}

export function getChat(id: string): ChatRow | undefined {
	return getDb().prepare('SELECT * FROM chats WHERE id = ?').get(id) as ChatRow | undefined;
}

export function listChats(vaultId: string, limit = 50): ChatRow[] {
	return getDb()
		.prepare('SELECT * FROM chats WHERE vault_id = ? ORDER BY updated_at DESC LIMIT ?')
		.all(vaultId, limit) as ChatRow[];
}

/** Used by the vault-deletion confirm dialog (vaults.ts's
 * describeVaultDeletion counter) and by deleteChatsForVault below. */
export function countChatsForVault(vaultId: string): number {
	const row = getDb()
		.prepare('SELECT COUNT(*) AS n FROM chats WHERE vault_id = ?')
		.get(vaultId) as { n: number };
	return row.n;
}

/** Called before vaults.deleteVault() removes the vault's folder — chats.db
 * is global, so vault deletion can't rely on the folder-delete cascading
 * into it. ON DELETE CASCADE on messages.chat_id handles messages. */
export function deleteChatsForVault(vaultId: string): void {
	getDb().prepare('DELETE FROM chats WHERE vault_id = ?').run(vaultId);
}

export function touchChat(id: string): void {
	getDb().prepare('UPDATE chats SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), id);
}

export function setChatTitle(id: string, title: string): void {
	getDb().prepare('UPDATE chats SET title = ? WHERE id = ?').run(title, id);
}

export function updateChatModel(id: string, model: string): void {
	getDb().prepare('UPDATE chats SET model = ? WHERE id = ?').run(model, id);
}

export function updateChatIncludedPaths(id: string, includedPaths: string[] | null): void {
	getDb()
		.prepare('UPDATE chats SET included_paths_json = ? WHERE id = ?')
		.run(includedPaths ? JSON.stringify(includedPaths) : null, id);
}

export interface InsertMessageInput {
	chatId: string;
	role: 'user' | 'assistant';
	content: string;
	thinking?: string | null;
	sourcesJson?: string | null;
}

export function insertMessage(input: InsertMessageInput): void {
	getDb()
		.prepare(
			`INSERT INTO messages (id, chat_id, role, content, thinking, sources_json, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`
		)
		.run(
			crypto.randomUUID(),
			input.chatId,
			input.role,
			input.content,
			input.thinking ?? null,
			input.sourcesJson ?? null,
			new Date().toISOString()
		);
}

export function getMessages(chatId: string): MessageRow[] {
	return getDb()
		.prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at ASC')
		.all(chatId) as MessageRow[];
}
