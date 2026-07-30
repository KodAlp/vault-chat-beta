import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { env } from '$env/dynamic/private';

export interface ChatRow {
	id: string;
	title: string | null;
	model: string;
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

/** Separate from data/vault-index.db on purpose — this is user history, the
 * index is regenerable vault content. `npm run index --full` must never touch it. */
function getDb(): Database.Database {
	if (!db) {
		const dbPath = env.CHATS_DB_PATH ?? path.join('data', 'chats.db');
		fs.mkdirSync(path.dirname(dbPath), { recursive: true });
		db = new Database(dbPath);
		db.pragma('journal_mode = WAL');
		db.exec(`
			CREATE TABLE IF NOT EXISTS chats (
				id TEXT PRIMARY KEY,
				title TEXT,
				model TEXT NOT NULL,
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
	}
	return db;
}

/**
 * Id is supplied by the caller, not generated here — the client generates it
 * (crypto.randomUUID(), same convention as ChatMessage.id) so the welcome
 * screen can navigate to /chat/{id} before the first message is even sent.
 */
export function createChat(id: string, model: string): ChatRow {
	const now = new Date().toISOString();
	const chat: ChatRow = { id, title: null, model, created_at: now, updated_at: now };
	getDb()
		.prepare(`INSERT INTO chats (id, title, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
		.run(chat.id, chat.title, chat.model, chat.created_at, chat.updated_at);
	return chat;
}

export function getChat(id: string): ChatRow | undefined {
	return getDb().prepare('SELECT * FROM chats WHERE id = ?').get(id) as ChatRow | undefined;
}

export function listChats(limit = 50): ChatRow[] {
	return getDb().prepare('SELECT * FROM chats ORDER BY updated_at DESC LIMIT ?').all(limit) as ChatRow[];
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
