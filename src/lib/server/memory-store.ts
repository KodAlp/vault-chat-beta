import type Database from 'better-sqlite3';

/**
 * Manual memory notes (GLOBAL/PERSONAL, STATED origin only in v1) in chats.db, the user-level database, NOT a
 * vault's — same reasoning as smalltalk_phrases (smalltalk-store.ts): "I prefer short answers" or "I'm a working
 * professional" isn't tied to which vault happens to be open. DOMAIN/LEARNING_HISTORY memory is never stored at
 * all in v1 — it is computed live from the learner profile and weak spots by memory-runtime.ts's computeMemoryBlock, exactly like the
 * progress and weak-spot pages already do, so no vault-scoped memory storage exists yet.
 *
 * Rows are immutable once written. Editing a note inserts a new row and points the old one's `superseded_by` at
 * it (§21 of the original spec: history is not silently destroyed); deleting sets `deleted_at` instead of
 * DELETE-ing the row, which is a different action from "the value changed" and deliberately gets its own column
 * rather than overloading `superseded_by` as a self-referencing tombstone. `idx_memory_live` excludes both.
 *
 * Takes a Database instead of opening one (like smalltalk-store.ts), so it runs against `:memory:` in tests and
 * has no import on chats-db.ts — chats-db.ts calls initMemorySchema() the same way it calls
 * initSmallTalkSchema(), and something importing getChatsDb() to actually use these functions lives in
 * memory-runtime.ts instead, to avoid a chats-db.ts <-> memory-store.ts import cycle.
 */

export type MemoryType = 'GLOBAL' | 'PERSONAL';

export interface MemoryRow {
	id: string;
	type: MemoryType;
	domain: string | null;
	key: string;
	value: string;
	origin: 'STATED';
	createdAt: string;
	supersededBy: string | null;
	deletedAt: string | null;
}

interface MemoryTableRow {
	id: string;
	type: string;
	domain: string | null;
	key: string;
	value_json: string;
	origin: string;
	created_at: string;
	superseded_by: string | null;
	deleted_at: string | null;
}

export function initMemorySchema(db: Database.Database): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS memory (
			id TEXT PRIMARY KEY,
			type TEXT NOT NULL,
			domain TEXT,
			key TEXT NOT NULL,
			value_json TEXT NOT NULL,
			origin TEXT NOT NULL,
			confidence REAL,
			evidence TEXT,
			created_at TEXT NOT NULL,
			superseded_by TEXT REFERENCES memory(id),
			deleted_at TEXT
		);
		CREATE INDEX IF NOT EXISTS idx_memory_live ON memory(type, domain, key) WHERE superseded_by IS NULL AND deleted_at IS NULL;
	`);
}

function toRow(r: MemoryTableRow): MemoryRow {
	return {
		id: r.id,
		type: r.type as MemoryType,
		domain: r.domain,
		key: r.key,
		value: (JSON.parse(r.value_json) as { value: string }).value,
		origin: 'STATED',
		createdAt: r.created_at,
		supersededBy: r.superseded_by,
		deletedAt: r.deleted_at
	};
}

/** Reserved for a future automated writer (OBSERVED/INFERRED) that needs a stable per-fact key to dedup against;
 * a manual note has no natural key of its own, so one is derived from its text. Not looked up by anything in v1. */
function slugify(value: string): string {
	return value.trim().slice(0, 40).toLowerCase().replace(/\s+/g, '-') || 'note';
}

export function addMemoryNote(db: Database.Database, input: { type: MemoryType; domain?: string | null; value: string }): MemoryRow {
	const row: MemoryTableRow = {
		id: crypto.randomUUID(),
		type: input.type,
		domain: input.domain ?? null,
		key: slugify(input.value),
		value_json: JSON.stringify({ value: input.value }),
		origin: 'STATED',
		created_at: new Date().toISOString(),
		superseded_by: null,
		deleted_at: null
	};
	db.prepare(
		`INSERT INTO memory (id, type, domain, key, value_json, origin, created_at, superseded_by, deleted_at)
		 VALUES (@id, @type, @domain, @key, @value_json, @origin, @created_at, @superseded_by, @deleted_at)`
	).run(row);
	return toRow(row);
}

/** Inserts a new row with the edited value and chains the old one to it via `superseded_by` — the old row stops
 * being "live" but is never deleted. Returns null if `id` does not name a live row. */
export function editMemoryNote(db: Database.Database, id: string, value: string): MemoryRow | null {
	const existing = db.prepare('SELECT * FROM memory WHERE id = ? AND superseded_by IS NULL AND deleted_at IS NULL').get(id) as MemoryTableRow | undefined;
	if (!existing) return null;
	const next = addMemoryNote(db, { type: existing.type as MemoryType, domain: existing.domain, value });
	db.prepare('UPDATE memory SET superseded_by = ? WHERE id = ?').run(next.id, id);
	return next;
}

/** Sets `deleted_at`; the row itself is kept (§21 — nothing is silently destroyed), just excluded from
 * idx_memory_live and from listLiveMemoryNotes(). Returns false if `id` does not name a live row. */
export function deleteMemoryNote(db: Database.Database, id: string): boolean {
	const changes = db
		.prepare('UPDATE memory SET deleted_at = ? WHERE id = ? AND superseded_by IS NULL AND deleted_at IS NULL')
		.run(new Date().toISOString(), id).changes;
	return changes > 0;
}

export function listLiveMemoryNotes(db: Database.Database): MemoryRow[] {
	const rows = db
		.prepare('SELECT * FROM memory WHERE superseded_by IS NULL AND deleted_at IS NULL ORDER BY created_at DESC')
		.all() as MemoryTableRow[];
	return rows.map(toRow);
}

/** `CHAT_MEMORY_GATE=0` (or off/false) switches memory off entirely — same kill-switch shape as
 * smallTalkGateEnabled (smalltalk-gate.ts). Default on. */
export function memoryGateEnabled(raw: string | undefined): boolean {
	const v = raw?.trim().toLowerCase();
	return !(v === '0' || v === 'off' || v === 'false');
}
