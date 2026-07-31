import type Database from 'better-sqlite3';

/**
 * `CREATE TABLE IF NOT EXISTS` only covers a table that doesn't exist yet —
 * once a column is added to a table's DDL after it has already shipped, an
 * existing on-disk DB never gets it and every query touching that column
 * fails with "no such column". This is chats.db's own `vault_id`/
 * `included_paths_json` fix (added post-Faz-8), extracted so every table
 * that adds a column later — in any DB, not just chats.db — follows the
 * same guard instead of reinventing it. `db.exec(CREATE TABLE ...)` must
 * run before this so `PRAGMA table_info` has a table to inspect.
 */
export function ensureColumns(db: Database.Database, table: string, columns: Record<string, string>): void {
	const existing = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
	for (const [name, ddl] of Object.entries(columns)) {
		if (!existing.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`);
	}
}
