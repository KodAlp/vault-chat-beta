import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { ensureColumns } from './sqlite-schema';

function tmpDb(): Database.Database {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-schema-test-'));
	const db = new Database(path.join(dir, 'test.db'));
	db.exec(`CREATE TABLE t (id TEXT PRIMARY KEY)`);
	return db;
}

test('adds a missing column', () => {
	const db = tmpDb();
	ensureColumns(db, 't', { extra: 'TEXT' });
	const cols = (db.prepare('PRAGMA table_info(t)').all() as { name: string }[]).map((c) => c.name);
	assert.deepEqual(cols, ['id', 'extra']);
	db.close();
});

test('is a no-op when the column already exists', () => {
	const db = tmpDb();
	ensureColumns(db, 't', { extra: 'TEXT' });
	ensureColumns(db, 't', { extra: 'TEXT' });
	const cols = (db.prepare('PRAGMA table_info(t)').all() as { name: string }[]).map((c) => c.name);
	assert.deepEqual(cols, ['id', 'extra']);
	db.close();
});

test('applies a DEFAULT to existing rows', () => {
	const db = tmpDb();
	db.prepare('INSERT INTO t (id) VALUES (?)').run('row-1');
	ensureColumns(db, 't', { status: `TEXT NOT NULL DEFAULT 'default'` });
	const row = db.prepare('SELECT status FROM t WHERE id = ?').get('row-1') as { status: string };
	assert.equal(row.status, 'default');
	db.close();
});
