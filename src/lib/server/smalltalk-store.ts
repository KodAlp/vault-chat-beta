import type Database from 'better-sqlite3';
import {
	DEFAULT_THRESHOLDS,
	dot,
	normalize,
	type GatePhrase,
	type GateThresholds,
	type PhraseKind,
	type PhraseSource
} from './smalltalk-gate';
import { SMALLTALK_SEEDS } from './smalltalk-seeds';
import { MAX_PHRASE_CHARS } from '../smalltalk-limits';

export { MAX_PHRASE_CHARS };

/**
 * The small-talk phrases smalltalk-gate.ts matches against, in chats.db — the
 * user-level database, NOT a vault's: slang belongs to the person, "naber lan" is
 * the same in every vault. Takes a Database instead of opening one (like
 * initChatsSchema) so it runs against `:memory:` in tests and imports nothing from
 * SvelteKit; the embedding call is injected for the same reason.
 *
 * Text is stored next to the vector so the user can see and delete what was
 * learned, and so the vectors can be rebuilt when the embedding model changes (a
 * vector from another model is meaningless, see `embed_model`). Only short phrases
 * are kept — this is a memory of how the user greets and swears, not of their
 * conversations, and chats.db already holds those.
 */

export type EmbedFn = (texts: string[]) => Promise<number[][]>;

/** Learned (non-seed) rows kept; beyond this the least recently used go first. */
export const MAX_LEARNED = 500;

export function initSmallTalkSchema(db: Database.Database): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS smalltalk_phrases (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			text TEXT NOT NULL,
			embedding BLOB NOT NULL,
			embed_model TEXT NOT NULL,
			source TEXT NOT NULL,
			kind TEXT NOT NULL DEFAULT 'smalltalk',
			blocked INTEGER NOT NULL DEFAULT 0,
			hits INTEGER NOT NULL DEFAULT 0,
			created_at TEXT NOT NULL,
			last_hit_at TEXT
		);
		CREATE INDEX IF NOT EXISTS idx_smalltalk_model ON smalltalk_phrases(embed_model);
		CREATE TABLE IF NOT EXISTS smalltalk_calibration (
			embed_model TEXT PRIMARY KEY,
			signature TEXT NOT NULL,
			thresholds_json TEXT NOT NULL,
			created_at TEXT NOT NULL
		);
	`);
}

function toBlob(vec: Float32Array): Buffer {
	return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

function fromBlob(buf: Buffer): Float32Array {
	// slice() copies, so the Float32Array is aligned no matter where the driver put the bytes
	return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

function tidy(text: string): string {
	return text.trim().replace(/\s+/g, ' ');
}

// Parsed phrases per handle and model — the gate runs every chat turn and the table is small
// but not free to decode. Every write here drops the entry.
const cache = new WeakMap<Database.Database, Map<string, GatePhrase[]>>();
const inflight = new WeakMap<Database.Database, Promise<void>>();

function invalidate(db: Database.Database): void {
	cache.delete(db);
}

interface Row {
	id: number;
	source: PhraseSource;
	kind: PhraseKind;
	blocked: number;
	embedding: Buffer;
}

/** Phrases embedded with `model` (rows from another model are skipped, see ensureReady). */
export function loadPhrases(db: Database.Database, model: string): GatePhrase[] {
	let byModel = cache.get(db);
	const hit = byModel?.get(model);
	if (hit) return hit;
	const rows = db
		.prepare('SELECT id, source, kind, blocked, embedding FROM smalltalk_phrases WHERE embed_model = ?')
		.all(model) as Row[];
	const phrases = rows.map((r) => ({ id: r.id, source: r.source, kind: r.kind, blocked: r.blocked === 1, vec: fromBlob(r.embedding) }));
	if (!byModel) cache.set(db, (byModel = new Map()));
	byModel.set(model, phrases);
	return phrases;
}

/** True once every seed exists for `model` — the gate is not used before that. */
export function isReady(db: Database.Database, model: string): boolean {
	const have = new Set(
		(db.prepare("SELECT text FROM smalltalk_phrases WHERE source = 'seed' AND embed_model = ?").all(model) as { text: string }[]).map((r) => r.text)
	);
	return SMALLTALK_SEEDS.every((s) => have.has(s)) && !hasStale(db, model);
}

function hasStale(db: Database.Database, model: string): boolean {
	return db.prepare('SELECT 1 FROM smalltalk_phrases WHERE embed_model != ? LIMIT 1').get(model) !== undefined;
}

/**
 * Brings the table in line with the current embedding model: re-embeds rows written
 * with another model (their text is kept for exactly this) and inserts any seed that
 * is missing. Idempotent; concurrent callers share one run. The first call after an
 * install embeds ~40 short texts (about 3 s on CPU); afterwards it is two counts.
 */
export function ensureReady(db: Database.Database, embed: EmbedFn, model: string): Promise<void> {
	const running = inflight.get(db);
	if (running) return running;
	const p = (async () => {
		const stale = db.prepare('SELECT id, text FROM smalltalk_phrases WHERE embed_model != ?').all(model) as { id: number; text: string }[];
		if (stale.length > 0) {
			const vectors = await embed(stale.map((r) => r.text));
			const upd = db.prepare('UPDATE smalltalk_phrases SET embedding = ?, embed_model = ? WHERE id = ?');
			db.transaction(() => stale.forEach((r, i) => upd.run(toBlob(normalize(vectors[i])), model, r.id)))();
		}
		const have = new Set(
			(db.prepare("SELECT text FROM smalltalk_phrases WHERE source = 'seed' AND embed_model = ?").all(model) as { text: string }[]).map((r) => r.text)
		);
		const missing = SMALLTALK_SEEDS.filter((s) => !have.has(s));
		if (missing.length > 0) {
			const vectors = await embed(missing);
			const ins = db.prepare(
				"INSERT INTO smalltalk_phrases (text, embedding, embed_model, source, kind, created_at) VALUES (?, ?, ?, 'seed', 'smalltalk', ?)"
			);
			const now = new Date().toISOString();
			db.transaction(() => missing.forEach((s, i) => ins.run(s, toBlob(normalize(vectors[i])), model, now)))();
		}
		invalidate(db);
	})().finally(() => inflight.delete(db));
	inflight.set(db, p);
	return p;
}

export function recordHit(db: Database.Database, id: number): void {
	db.prepare('UPDATE smalltalk_phrases SET hits = hits + 1, last_hit_at = ? WHERE id = ?').run(new Date().toISOString(), id);
}

function nearest(phrases: GatePhrase[], vec: Float32Array, kind: PhraseKind): { id: number; sim: number } | null {
	let best: { id: number; sim: number } | null = null;
	for (const p of phrases) {
		if (p.kind !== kind) continue;
		const sim = dot(vec, p.vec);
		if (!best || sim > best.sim) best = { id: p.id, sim };
	}
	return best;
}

function insert(db: Database.Database, model: string, text: string, vec: Float32Array, source: PhraseSource, kind: PhraseKind): number {
	const info = db
		.prepare('INSERT INTO smalltalk_phrases (text, embedding, embed_model, source, kind, created_at) VALUES (?, ?, ?, ?, ?, ?)')
		.run(text, toBlob(vec), model, source, kind, new Date().toISOString());
	invalidate(db);
	return Number(info.lastInsertRowid);
}

function evictOverflow(db: Database.Database, max: number): void {
	const count = (db.prepare("SELECT count(*) AS c FROM smalltalk_phrases WHERE source != 'seed'").get() as { c: number }).c;
	if (count <= max) return;
	// confirmed questions are the safety net against a repeat false flag: evict them last
	db.prepare(
		`DELETE FROM smalltalk_phrases WHERE id IN (
			SELECT id FROM smalltalk_phrases WHERE source != 'seed'
			ORDER BY (kind = 'question') ASC, COALESCE(last_hit_at, created_at) ASC
			LIMIT ?
		)`
	).run(count - max);
	invalidate(db);
}

export interface LearnResult {
	id: number;
	created: boolean;
}

/**
 * Remembers `text` (embedded as `vec`) as small talk. Returns null when it is not worth
 * keeping: empty, too long to be small talk, a message the user already confirmed as a
 * question, or a duplicate (which only counts as another hit on the existing phrase).
 */
export function learn(
	db: Database.Database,
	model: string,
	text: string,
	vec: ArrayLike<number>,
	source: 'auto' | 'user',
	opts: { maxLearned?: number; thresholds?: GateThresholds } = {}
): LearnResult | null {
	const clean = tidy(text);
	if (!clean || clean.length > MAX_PHRASE_CHARS) return null;
	const { negativeSim, duplicateSim } = opts.thresholds ?? DEFAULT_THRESHOLDS;
	const v = normalize(vec);
	const phrases = loadPhrases(db, model);
	const veto = nearest(phrases, v, 'question');
	if (veto && veto.sim >= negativeSim) return null;
	const dup = nearest(phrases.filter((p) => !p.blocked), v, 'smalltalk');
	if (dup && dup.sim >= duplicateSim) {
		recordHit(db, dup.id);
		return { id: dup.id, created: false };
	}
	// The user explicitly teaching a phrase overrides an earlier block on a near-duplicate.
	if (source === 'user') {
		const blockedDup = nearest(phrases.filter((p) => p.blocked && p.source !== 'seed'), v, 'smalltalk');
		if (blockedDup && blockedDup.sim >= duplicateSim) {
			db.prepare('UPDATE smalltalk_phrases SET blocked = 0 WHERE id = ?').run(blockedDup.id);
			invalidate(db);
			return { id: blockedDup.id, created: false };
		}
	}
	const id = insert(db, model, clean, v, source, 'smalltalk');
	evictOverflow(db, opts.maxLearned ?? MAX_LEARNED);
	return { id, created: true };
}

/** The user pressed "Yine de kaynak ara": this message is a question. It vetoes later flags of
 * anything close to it, and the learned (never seed) phrase that wrongly flagged it stops matching. */
export function confirmQuestion(
	db: Database.Database,
	model: string,
	text: string,
	vec: ArrayLike<number>,
	blockPhraseId?: number,
	thresholds: GateThresholds = DEFAULT_THRESHOLDS
): void {
	if (blockPhraseId !== undefined) {
		db.prepare("UPDATE smalltalk_phrases SET blocked = 1 WHERE id = ? AND source != 'seed'").run(blockPhraseId);
		invalidate(db);
	}
	const clean = tidy(text);
	if (!clean) return;
	const v = normalize(vec);
	const dup = nearest(loadPhrases(db, model), v, 'question');
	if (dup && dup.sim >= thresholds.duplicateSim) return;
	// question texts are stored truncated: they are only a label for the settings list
	insert(db, model, clean.slice(0, 200), v, 'user', 'question');
	evictOverflow(db, MAX_LEARNED);
}

export interface PhraseListItem {
	id: number;
	text: string;
	source: PhraseSource;
	kind: PhraseKind;
	blocked: boolean;
	hits: number;
	createdAt: string;
	lastHitAt: string | null;
}

/** What the user can see and remove: everything learned or confirmed, plus seeds that were switched off. */
export function listPhrases(db: Database.Database): PhraseListItem[] {
	const rows = db
		.prepare(
			`SELECT id, text, source, kind, blocked, hits, created_at, last_hit_at FROM smalltalk_phrases
			 WHERE source != 'seed' OR blocked = 1
			 ORDER BY COALESCE(last_hit_at, created_at) DESC`
		)
		.all() as { id: number; text: string; source: PhraseSource; kind: PhraseKind; blocked: number; hits: number; created_at: string; last_hit_at: string | null }[];
	return rows.map((r) => ({ id: r.id, text: r.text, source: r.source, kind: r.kind, blocked: r.blocked === 1, hits: r.hits, createdAt: r.created_at, lastHitAt: r.last_hit_at }));
}

/** Removes a learned phrase; a seed cannot be deleted (it would be re-inserted) so it is switched off instead. */
export function deletePhrase(db: Database.Database, id: number): boolean {
	const row = db.prepare('SELECT source FROM smalltalk_phrases WHERE id = ?').get(id) as { source: PhraseSource } | undefined;
	if (!row) return false;
	if (row.source === 'seed') db.prepare('UPDATE smalltalk_phrases SET blocked = 1 WHERE id = ?').run(id);
	else db.prepare('DELETE FROM smalltalk_phrases WHERE id = ?').run(id);
	invalidate(db);
	return true;
}

/** Forgets everything learned and switches every seed back on. */
export function clearLearned(db: Database.Database): number {
	const removed = db.prepare("DELETE FROM smalltalk_phrases WHERE source != 'seed'").run().changes;
	db.prepare("UPDATE smalltalk_phrases SET blocked = 0 WHERE source = 'seed'").run();
	invalidate(db);
	return removed;
}

/** The calibration stored for `model`, only if it was derived from the same seeds/probes (`signature`). */
export function loadCalibration(db: Database.Database, model: string, signature: string): GateThresholds | null {
	const row = db.prepare('SELECT signature, thresholds_json FROM smalltalk_calibration WHERE embed_model = ?').get(model) as
		| { signature: string; thresholds_json: string }
		| undefined;
	if (!row || row.signature !== signature) return null;
	try {
		const t = JSON.parse(row.thresholds_json) as GateThresholds;
		return typeof t.seedSim === 'number' && typeof t.personalSim === 'number' && typeof t.negativeSim === 'number' && typeof t.duplicateSim === 'number' ? t : null;
	} catch {
		return null;
	}
}

export function saveCalibration(db: Database.Database, model: string, signature: string, t: GateThresholds): void {
	db.prepare('INSERT OR REPLACE INTO smalltalk_calibration (embed_model, signature, thresholds_json, created_at) VALUES (?, ?, ?, ?)').run(
		model,
		signature,
		JSON.stringify(t),
		new Date().toISOString()
	);
}
