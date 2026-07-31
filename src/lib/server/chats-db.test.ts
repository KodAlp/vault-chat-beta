import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { initChatsSchema } from './chats-db';

function tmpDb(): Database.Database {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chats-db-test-'));
	return new Database(path.join(dir, 'chats.db'));
}

function columnNames(db: Database.Database, table: string): string[] {
	return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
}

test('initChatsSchema creates a fresh DB with vault_id and its index', () => {
	const db = tmpDb();
	initChatsSchema(db);

	assert.ok(columnNames(db, 'chats').includes('vault_id'));
	const indexes = (db.prepare(`PRAGMA index_list(chats)`).all() as { name: string }[]).map((i) => i.name);
	assert.ok(indexes.includes('idx_chats_vault_id'));
	db.close();
});

test('initChatsSchema backfills vault_id on a pre-existing chats table that lacks it', () => {
	// Simulates a pre-Faz-8 (or otherwise unmigrated) chats.db: the table
	// already exists, but without vault_id — the exact shape that made
	// `CREATE INDEX ... ON chats(vault_id)` blow up when it ran before the
	// ALTER guard instead of after.
	const db = tmpDb();
	db.exec(`
		CREATE TABLE chats (
			id TEXT PRIMARY KEY,
			title TEXT,
			model TEXT NOT NULL,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
		INSERT INTO chats (id, title, model, created_at, updated_at)
		VALUES ('legacy-1', 'Eski sohbet', 'qwen3:8b', '2026-01-01', '2026-01-01');
	`);

	assert.doesNotThrow(() => initChatsSchema(db));

	const cols = columnNames(db, 'chats');
	assert.ok(cols.includes('vault_id'));
	assert.ok(cols.includes('included_paths_json'));

	const row = db.prepare('SELECT vault_id FROM chats WHERE id = ?').get('legacy-1') as { vault_id: string };
	assert.equal(row.vault_id, 'default');

	const indexes = (db.prepare(`PRAGMA index_list(chats)`).all() as { name: string }[]).map((i) => i.name);
	assert.ok(indexes.includes('idx_chats_vault_id'));
	db.close();
});
