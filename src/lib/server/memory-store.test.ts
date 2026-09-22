import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { addMemoryNote, deleteMemoryNote, editMemoryNote, initMemorySchema, listLiveMemoryNotes, memoryGateEnabled } from './memory-store';

function fresh(): Database.Database {
	const db = new Database(':memory:');
	initMemorySchema(db);
	return db;
}

test('a fresh table has no live notes', () => {
	assert.deepEqual(listLiveMemoryNotes(fresh()), []);
});

test('an added note is live and round-trips its value', () => {
	const db = fresh();
	const row = addMemoryNote(db, { type: 'PERSONAL', value: 'Kısa cevapları tercih ederim.' });
	assert.equal(row.type, 'PERSONAL');
	assert.equal(row.value, 'Kısa cevapları tercih ederim.');
	assert.equal(row.origin, 'STATED');
	assert.equal(row.supersededBy, null);
	assert.equal(row.deletedAt, null);
	const live = listLiveMemoryNotes(db);
	assert.equal(live.length, 1);
	assert.equal(live[0].id, row.id);
});

test('domain is optional and stored as given', () => {
	const db = fresh();
	const withDomain = addMemoryNote(db, { type: 'GLOBAL', domain: 'math', value: 'x' });
	const without = addMemoryNote(db, { type: 'GLOBAL', value: 'y' });
	assert.equal(withDomain.domain, 'math');
	assert.equal(without.domain, null);
});

test('editing a note supersedes the old row: the old one drops out of the live list, the new one carries the value', () => {
	const db = fresh();
	const original = addMemoryNote(db, { type: 'PERSONAL', value: 'eski değer' });
	const edited = editMemoryNote(db, original.id, 'yeni değer');
	assert.ok(edited);
	assert.equal(edited!.value, 'yeni değer');
	assert.notEqual(edited!.id, original.id, 'a new row, not a mutation');

	const live = listLiveMemoryNotes(db);
	assert.equal(live.length, 1);
	assert.equal(live[0].id, edited!.id);

	// the old row is not deleted, just no longer live
	const oldRow = db.prepare('SELECT superseded_by, deleted_at FROM memory WHERE id = ?').get(original.id) as { superseded_by: string; deleted_at: string | null };
	assert.equal(oldRow.superseded_by, edited!.id);
	assert.equal(oldRow.deleted_at, null);
});

test('editing an already-superseded or deleted id fails (no such live row)', () => {
	const db = fresh();
	const a = addMemoryNote(db, { type: 'PERSONAL', value: 'a' });
	editMemoryNote(db, a.id, 'b');
	assert.equal(editMemoryNote(db, a.id, 'c'), null, 'a.id is no longer live, it was superseded');

	const d = addMemoryNote(db, { type: 'PERSONAL', value: 'd' });
	deleteMemoryNote(db, d.id);
	assert.equal(editMemoryNote(db, d.id, 'e'), null);
});

test('deleting a note sets deleted_at and removes it from the live list, but the row still exists', () => {
	const db = fresh();
	const row = addMemoryNote(db, { type: 'GLOBAL', value: 'x' });
	assert.equal(deleteMemoryNote(db, row.id), true);
	assert.deepEqual(listLiveMemoryNotes(db), []);
	const stored = db.prepare('SELECT deleted_at FROM memory WHERE id = ?').get(row.id) as { deleted_at: string | null };
	assert.ok(stored.deleted_at, 'the row is kept, not DELETEd');
});

test('deleting an unknown or already-deleted id returns false', () => {
	const db = fresh();
	assert.equal(deleteMemoryNote(db, 'nope'), false);
	const row = addMemoryNote(db, { type: 'GLOBAL', value: 'x' });
	deleteMemoryNote(db, row.id);
	assert.equal(deleteMemoryNote(db, row.id), false, 'already deleted');
});

test('listLiveMemoryNotes orders most recent first', () => {
	const db = fresh();
	const first = addMemoryNote(db, { type: 'PERSONAL', value: 'first' });
	db.prepare("UPDATE memory SET created_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(first.id);
	const second = addMemoryNote(db, { type: 'PERSONAL', value: 'second' });
	db.prepare("UPDATE memory SET created_at = '2020-06-01T00:00:00.000Z' WHERE id = ?").run(second.id);
	const live = listLiveMemoryNotes(db);
	assert.deepEqual(live.map((n) => n.value), ['second', 'first']);
});

test('memoryGateEnabled: off/0/false (any case, trimmed) disable it, everything else including undefined leaves it on', () => {
	for (const off of ['0', 'off', 'OFF', 'false', ' False ']) assert.equal(memoryGateEnabled(off), false, off);
	for (const on of [undefined, '', '1', 'on', 'true', 'yes']) assert.equal(memoryGateEnabled(on), true, String(on));
});
