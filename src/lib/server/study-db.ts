import Database from 'better-sqlite3';
import type { CognitiveLevel } from '../cognitive-levels';
import type { CardSchedule } from './schedule';
import type { VaultContext } from './vaults';
import type { LearnerProfile } from '../learner-model';
import { logAppEvent } from './app-log';

/** Shared shape for every "what's been generated in this vault" list
 * — id/title/model/created_at is the one thing all five
 * generated-material tables have in common. Each list*() below selects
 * only these columns rather than `SELECT *`, so a large payload (e.g.
 * slidedecks.rendered_html/rendered_css) never gets dragged along just to
 * populate a list view. */
export interface StudyListRow {
	id: string;
	title: string;
	model: string;
	created_at: string;
}

export interface QuizRow {
	id: string;
	title: string;
	scope_json: string;
	model: string;
	created_at: string;
}

export interface QuizItemRow {
	id: string;
	quiz_id: string;
	position: number;
	type: 'multiple_choice' | 'true_false' | 'open';
	question: string;
	options_json: string | null;
	answer: string;
	explanation: string;
	source_path: string;
	heading_path: string;
	/** Set when the user flagged the question as faulty ("Bu soru hatalı"): it is no longer asked, no longer counts in the
	 * score shown, and must not count as learning evidence. null = fine. */
	flagged_at: string | null;
	/** The level the question targets; null for questions generated before levels existed and for providers that ignored the schema. */
	cognitive_level: string | null;
}

export interface AttemptRow {
	id: string;
	quiz_id: string;
	started_at: string;
	finished_at: string | null;
	score: number | null;
}

export interface AttemptAnswerRow {
	id: string;
	attempt_id: string;
	item_id: string;
	given: string;
	is_correct: 0 | 1;
	model_feedback: string | null;
}

const dbCache = new Map<string, Database.Database>();

/** Separate from chats.db/index.db — generated study material, its own
 * lifecycle (quizzes/cards get created, retaken, eventually pruned by the
 * user), not part of either conversation history or the regenerable index.
 * One connection per vault, cached for the process lifetime (mirrors the
 * old module-level singleton, keyed by vault id now). */
/** Column additions after first ship go through `addMissingColumns()` below
 * (this file's own hand-rolled equivalent of sqlite-schema.ts's shared
 * `ensureColumns` — predates that extraction, never consolidated onto it):
 * add the column to the `CREATE TABLE` below for a fresh install AND to
 * `addMissingColumns`'s `pending` list for an existing on-disk study.db,
 * same two-places rule as chats-db.ts's `vault_id`/`included_paths_json` —
 * otherwise every pre-existing study.db fails with "no such column" the
 * instant that code path runs. */
function getDb(v: VaultContext): Database.Database {
	let db = dbCache.get(v.id);
	if (db) return db;
	const instance = new Database(v.studyDbPath);
	// A pragma/exec failure here must not leave an open handle uncached — see
	// the identical fix (and its EBUSY rationale) in chats-db.ts's getDb().
	try {
		instance.pragma('journal_mode = WAL');
		// Without this, better-sqlite3/SQLite silently ignores every declared
		// `ON DELETE CASCADE` below (quiz_items/attempts/cards/report_sections/
		// mindmap_nodes/slides all reference their parent this way) — foreign
		// key enforcement is off by default per-connection, not a database-file
		// property. Same fix, same rationale, as chats-db.ts's identical pragma
		// (that one shipped without it first and left orphaned rows behind
		// until caught). Deleting a quiz/deck/report/mindmap/slidedeck below
		// depends on this actually being on.
		instance.pragma('foreign_keys = ON');
		instance.exec(`
			CREATE TABLE IF NOT EXISTS quizzes (
				id TEXT PRIMARY KEY,
				title TEXT NOT NULL,
				scope_json TEXT NOT NULL,
				model TEXT NOT NULL,
				created_at TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS quiz_items (
				id TEXT PRIMARY KEY,
				quiz_id TEXT NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
				position INTEGER NOT NULL,
				type TEXT NOT NULL,
				question TEXT NOT NULL,
				options_json TEXT,
				answer TEXT NOT NULL,
				explanation TEXT NOT NULL,
				source_path TEXT NOT NULL,
				heading_path TEXT NOT NULL,
				flagged_at TEXT,
				cognitive_level TEXT
			);
			CREATE INDEX IF NOT EXISTS idx_quiz_items_quiz_id ON quiz_items(quiz_id);
			CREATE TABLE IF NOT EXISTS attempts (
				id TEXT PRIMARY KEY,
				quiz_id TEXT NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
				started_at TEXT NOT NULL,
				finished_at TEXT,
				score REAL
			);
			CREATE TABLE IF NOT EXISTS attempt_answers (
				id TEXT PRIMARY KEY,
				attempt_id TEXT NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
				item_id TEXT NOT NULL,
				given TEXT NOT NULL,
				is_correct INTEGER NOT NULL,
				model_feedback TEXT
			);
			CREATE INDEX IF NOT EXISTS idx_attempt_answers_attempt_id ON attempt_answers(attempt_id);
			CREATE TABLE IF NOT EXISTS decks (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL,
				scope_json TEXT NOT NULL,
				model TEXT NOT NULL,
				created_at TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS cards (
				id TEXT PRIMARY KEY,
				deck_id TEXT NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
				front TEXT NOT NULL,
				back TEXT NOT NULL,
				source_path TEXT NOT NULL,
				heading_path TEXT NOT NULL,
				domain TEXT NOT NULL,
				level TEXT NOT NULL,
				ease REAL NOT NULL,
				interval_days INTEGER NOT NULL,
				due_at TEXT NOT NULL,
				reps INTEGER NOT NULL,
				lapses INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_cards_due ON cards(due_at);
			CREATE INDEX IF NOT EXISTS idx_cards_deck_id ON cards(deck_id);
			CREATE TABLE IF NOT EXISTS reports (
				id TEXT PRIMARY KEY,
				title TEXT NOT NULL,
				scope_json TEXT NOT NULL,
				model TEXT NOT NULL,
				created_at TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS report_sections (
				id TEXT PRIMARY KEY,
				report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
				position INTEGER NOT NULL,
				heading TEXT NOT NULL,
				body_markdown TEXT NOT NULL,
				source_paths_json TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_report_sections_report_id ON report_sections(report_id);
			CREATE TABLE IF NOT EXISTS mindmaps (
				id TEXT PRIMARY KEY,
				title TEXT NOT NULL,
				scope_json TEXT NOT NULL,
				model TEXT NOT NULL,
				created_at TEXT NOT NULL,
				root_summary TEXT NOT NULL DEFAULT ''
			);
			CREATE TABLE IF NOT EXISTS mindmap_nodes (
				id TEXT PRIMARY KEY,
				mindmap_id TEXT NOT NULL REFERENCES mindmaps(id) ON DELETE CASCADE,
				position INTEGER NOT NULL,
				path_json TEXT NOT NULL,
				source_path TEXT NOT NULL,
				heading_path TEXT NOT NULL,
				summary TEXT NOT NULL DEFAULT ''
			);
			CREATE INDEX IF NOT EXISTS idx_mindmap_nodes_mindmap_id ON mindmap_nodes(mindmap_id);
			CREATE TABLE IF NOT EXISTS slidedecks (
				id TEXT PRIMARY KEY,
				title TEXT NOT NULL,
				scope_json TEXT NOT NULL,
				model TEXT NOT NULL,
				created_at TEXT NOT NULL,
				rendered_html TEXT NOT NULL,
				rendered_css TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS slides (
				id TEXT PRIMARY KEY,
				deck_id TEXT NOT NULL REFERENCES slidedecks(id) ON DELETE CASCADE,
				position INTEGER NOT NULL,
				layout TEXT NOT NULL DEFAULT 'bullets',
				heading TEXT NOT NULL DEFAULT '',
				content_markdown TEXT NOT NULL,
				notes TEXT,
				source_path TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_slides_deck_id ON slides(deck_id);
				CREATE TABLE IF NOT EXISTS skill_nodes (
					id TEXT PRIMARY KEY,
					name TEXT NOT NULL,
					kind TEXT NOT NULL,
					domains_json TEXT NOT NULL DEFAULT '[]',
					source_path TEXT,
					created_at TEXT NOT NULL
				);
				CREATE TABLE IF NOT EXISTS skill_state (
					id TEXT PRIMARY KEY,
					skill_id TEXT NOT NULL REFERENCES skill_nodes(id) ON DELETE CASCADE,
					observed_at TEXT NOT NULL,
					mastery REAL,
					mastery_basic REAL,
					mastery_applied REAL,
					retention REAL,
					evidence_count INTEGER NOT NULL,
					retention_cards INTEGER NOT NULL DEFAULT 0,
					confidence TEXT NOT NULL,
					origin TEXT NOT NULL
				);
				CREATE INDEX IF NOT EXISTS idx_skill_state_skill ON skill_state(skill_id, observed_at);
		`);
		addMissingColumns(instance);
	} catch (err) {
		instance.close();
		const message = err instanceof Error ? err.message : 'Bilinmeyen hata';
		logAppEvent({ kind: 'db_error', message: `study.db init başarısız (${v.id}): ${message}` });
		throw err;
	}
	dbCache.set(v.id, instance);
	return instance;
}

/**
 * Adds columns that were introduced after a study.db was first created.
 *
 * CREATE TABLE IF NOT EXISTS above does nothing for an existing database, so
 * new columns would otherwise only reach fresh vaults. There is no migration
 * framework in this project (no user_version, no ALTER TABLE anywhere before
 * this), and the alternative — dropping and recreating — would delete quizzes,
 * decks and reports the user actually generated. So: check what is there,
 * add only what is missing, leave the rows alone. Old mind maps keep working
 * with an empty summary rather than disappearing.
 *
 * Every column added here MUST have a default, since existing rows are not
 * rewritten.
 */
function addMissingColumns(db: Database.Database): void {
	const pending: { table: string; column: string; ddl: string }[] = [
		{ table: 'mindmaps', column: 'root_summary', ddl: "TEXT NOT NULL DEFAULT ''" },
		{ table: 'mindmap_nodes', column: 'summary', ddl: "TEXT NOT NULL DEFAULT ''" },
		{ table: 'quiz_items', column: 'flagged_at', ddl: 'TEXT' },
		{ table: 'quiz_items', column: 'cognitive_level', ddl: 'TEXT' },
		// A slide deck generated before this shipped keeps
		// rendering fine (rendered_html/rendered_css already has the old
		// plain-theme markup baked in) — these just backfill the row shape
		// so getSlides() doesn't return `undefined` for them.
		{ table: 'slides', column: 'layout', ddl: "TEXT NOT NULL DEFAULT 'bullets'" },
		{ table: 'slides', column: 'heading', ddl: "TEXT NOT NULL DEFAULT ''" },
		{ table: 'slides', column: 'notes', ddl: 'TEXT' }
	];
	for (const { table, column, ddl } of pending) {
		const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
		if (columns.some((c) => c.name === column)) continue;
		db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
	}
}

/** Must be called before deleting a vault's files — Windows refuses to
 * remove/rename a file with an open handle (EBUSY), and this cache holds
 * one open connection per vault for the process lifetime. See
 * vaults.ts's deleteVault. No-op if this vault's study DB was never opened. */
export function closeVaultStudyDb(vaultId: string): void {
	const db = dbCache.get(vaultId);
	if (!db) return;
	db.close();
	dbCache.delete(vaultId);
}

export interface NewQuizItem {
	type: 'multiple_choice' | 'true_false' | 'open';
	question: string;
	options?: string[];
	answer: string;
	explanation: string;
	source_path: string;
	heading_path: string;
	cognitiveLevel?: CognitiveLevel | null;
}

export function createQuiz(v: VaultContext, title: string, scope: unknown, model: string, items: NewQuizItem[]): string {
	const id = crypto.randomUUID();
	const now = new Date().toISOString();
	const database = getDb(v);
	const tx = database.transaction(() => {
		database
			.prepare(`INSERT INTO quizzes (id, title, scope_json, model, created_at) VALUES (?, ?, ?, ?, ?)`)
			.run(id, title, JSON.stringify(scope), model, now);

		const insertItem = database.prepare(
			`INSERT INTO quiz_items (id, quiz_id, position, type, question, options_json, answer, explanation, source_path, heading_path, cognitive_level)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		);
		items.forEach((item, position) => {
			insertItem.run(
				crypto.randomUUID(),
				id,
				position,
				item.type,
				item.question,
				item.options ? JSON.stringify(item.options) : null,
				item.answer,
				item.explanation,
				item.source_path,
				item.heading_path,
				item.cognitiveLevel ?? null
			);
		});
	});
	tx();
	return id;
}

export function getQuiz(v: VaultContext, id: string): QuizRow | undefined {
	return getDb(v).prepare('SELECT * FROM quizzes WHERE id = ?').get(id) as QuizRow | undefined;
}

export function getQuizItems(v: VaultContext, quizId: string): QuizItemRow[] {
	return getDb(v)
		.prepare('SELECT * FROM quiz_items WHERE quiz_id = ? ORDER BY position ASC')
		.all(quizId) as QuizItemRow[];
}

export function getQuizItem(v: VaultContext, id: string): QuizItemRow | undefined {
	return getDb(v).prepare('SELECT * FROM quiz_items WHERE id = ?').get(id) as QuizItemRow | undefined;
}

/** Most recent first — what a "recently generated" list wants to show. */
/** Flags (or un-flags) a question as faulty. False when no such question exists. */
export function setQuizItemFlagged(v: VaultContext, itemId: string, flagged: boolean): boolean {
	return getDb(v).prepare('UPDATE quiz_items SET flagged_at = ? WHERE id = ?').run(flagged ? new Date().toISOString() : null, itemId).changes > 0;
}

export function listQuizzes(v: VaultContext): StudyListRow[] {
	return getDb(v)
		.prepare('SELECT id, title, model, created_at FROM quizzes ORDER BY created_at DESC')
		.all() as StudyListRow[];
}

/** ON DELETE CASCADE (quiz_items, attempts -> attempt_answers) handles the
 * rest — see getDb()'s foreign_keys pragma. */
export function deleteQuiz(v: VaultContext, id: string): void {
	getDb(v).prepare('DELETE FROM quizzes WHERE id = ?').run(id);
}

export function createAttempt(v: VaultContext, quizId: string): string {
	const id = crypto.randomUUID();
	getDb(v)
		.prepare('INSERT INTO attempts (id, quiz_id, started_at) VALUES (?, ?, ?)')
		.run(id, quizId, new Date().toISOString());
	return id;
}

export function getAttempt(v: VaultContext, id: string): AttemptRow | undefined {
	return getDb(v).prepare('SELECT * FROM attempts WHERE id = ?').get(id) as AttemptRow | undefined;
}

export function finishAttempt(v: VaultContext, id: string, score: number): void {
	getDb(v)
		.prepare('UPDATE attempts SET finished_at = ?, score = ? WHERE id = ?')
		.run(new Date().toISOString(), score, id);
}

export function insertAttemptAnswer(
	v: VaultContext,
	input: {
		attemptId: string;
		itemId: string;
		given: string;
		isCorrect: boolean;
		modelFeedback?: string | null;
	}
): void {
	getDb(v)
		.prepare(
			`INSERT INTO attempt_answers (id, attempt_id, item_id, given, is_correct, model_feedback)
			 VALUES (?, ?, ?, ?, ?, ?)`
		)
		.run(
			crypto.randomUUID(),
			input.attemptId,
			input.itemId,
			input.given,
			input.isCorrect ? 1 : 0,
			input.modelFeedback ?? null
		);
}

export function getAttemptAnswers(v: VaultContext, attemptId: string): AttemptAnswerRow[] {
	return getDb(v)
		.prepare('SELECT * FROM attempt_answers WHERE attempt_id = ?')
		.all(attemptId) as AttemptAnswerRow[];
}

export interface DeckRow {
	id: string;
	name: string;
	scope_json: string;
	model: string;
	created_at: string;
}

export interface CardRow {
	id: string;
	deck_id: string;
	front: string;
	back: string;
	source_path: string;
	heading_path: string;
	domain: string;
	level: string;
	ease: number;
	interval_days: number;
	due_at: string;
	reps: number;
	lapses: number;
}

export interface NewCard {
	front: string;
	back: string;
	source_path: string;
	heading_path: string;
	domain: string;
	level: string;
}

export function createDeck(v: VaultContext, name: string, scope: unknown, model: string, items: NewCard[]): string {
	const id = crypto.randomUUID();
	const now = new Date().toISOString();
	const database = getDb(v);
	const tx = database.transaction(() => {
		database
			.prepare(`INSERT INTO decks (id, name, scope_json, model, created_at) VALUES (?, ?, ?, ?, ?)`)
			.run(id, name, JSON.stringify(scope), model, now);

		const insertCard = database.prepare(
			`INSERT INTO cards (id, deck_id, front, back, source_path, heading_path, domain, level, ease, interval_days, due_at, reps, lapses)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		);
		for (const item of items) {
			insertCard.run(
				crypto.randomUUID(),
				id,
				item.front,
				item.back,
				item.source_path,
				item.heading_path,
				item.domain,
				item.level,
				2.5,
				1,
				now,
				0,
				0
			);
		}
	});
	tx();
	return id;
}

export function getDeck(v: VaultContext, id: string): DeckRow | undefined {
	return getDb(v).prepare('SELECT * FROM decks WHERE id = ?').get(id) as DeckRow | undefined;
}

/** Every card in one deck, unfiltered by due date — the per-deck study page
 * (/study/cards/[id]) uses this, not getDueCards: opening a deck you
 * explicitly picked should show that deck's material now, not gate on
 * today's spaced-repetition schedule the way the flat cross-deck queue
 * does. Grading still updates real scheduling either way (same
 * updateCardSchedule call as the flat queue). */
export function getDeckCards(v: VaultContext, deckId: string): CardRow[] {
	return getDb(v).prepare('SELECT * FROM cards WHERE deck_id = ?').all(deckId) as CardRow[];
}

export function getCard(v: VaultContext, id: string): CardRow | undefined {
	return getDb(v).prepare('SELECT * FROM cards WHERE id = ?').get(id) as CardRow | undefined;
}

/** decks.name, not decks.title — aliased to `title` so callers can treat
 * every generated-material list the same way (see StudyListRow). */
export function listDecks(v: VaultContext): StudyListRow[] {
	return getDb(v)
		.prepare('SELECT id, name AS title, model, created_at FROM decks ORDER BY created_at DESC')
		.all() as StudyListRow[];
}

/** ON DELETE CASCADE (cards) handles the rest — see getDb()'s foreign_keys
 * pragma. */
export function deleteDeck(v: VaultContext, id: string): void {
	getDb(v).prepare('DELETE FROM decks WHERE id = ?').run(id);
}

/** `deckId` optional (per-deck review): without it, counts due cards
 * across every deck, same as before — the flat /study/cards queue's global
 * badge. With it, scopes to one deck, e.g. StudyPanel's per-deck due badge. */
export function getDueCount(v: VaultContext, nowIso: string, deckId?: string): number {
	const row = deckId
		? (getDb(v)
				.prepare('SELECT COUNT(*) AS n FROM cards WHERE deck_id = ? AND due_at <= ?')
				.get(deckId, nowIso) as { n: number })
		: (getDb(v).prepare('SELECT COUNT(*) AS n FROM cards WHERE due_at <= ?').get(nowIso) as { n: number });
	return row.n;
}

/** `deckId` optional, same as getDueCount above. */
export function getDueCards(v: VaultContext, nowIso: string, limit: number, deckId?: string): CardRow[] {
	if (deckId) {
		return getDb(v)
			.prepare('SELECT * FROM cards WHERE deck_id = ? AND due_at <= ? ORDER BY due_at ASC LIMIT ?')
			.all(deckId, nowIso, limit) as CardRow[];
	}
	return getDb(v)
		.prepare('SELECT * FROM cards WHERE due_at <= ? ORDER BY due_at ASC LIMIT ?')
		.all(nowIso, limit) as CardRow[];
}

export function updateCardSchedule(v: VaultContext, id: string, s: CardSchedule): void {
	getDb(v)
		.prepare(
			'UPDATE cards SET ease = ?, interval_days = ?, due_at = ?, reps = ?, lapses = ? WHERE id = ?'
		)
		.run(s.ease, s.interval_days, s.due_at, s.reps, s.lapses, id);
}

export interface ReportRow {
	id: string;
	title: string;
	scope_json: string;
	model: string;
	created_at: string;
}

export interface ReportSectionRow {
	id: string;
	report_id: string;
	position: number;
	heading: string;
	body_markdown: string;
	source_paths_json: string;
}

export interface NewReportSection {
	heading: string;
	body_markdown: string;
	source_paths: string[];
}

export function createReport(
	v: VaultContext,
	title: string,
	scope: unknown,
	model: string,
	sections: NewReportSection[]
): string {
	const id = crypto.randomUUID();
	const now = new Date().toISOString();
	const database = getDb(v);
	const tx = database.transaction(() => {
		database
			.prepare(`INSERT INTO reports (id, title, scope_json, model, created_at) VALUES (?, ?, ?, ?, ?)`)
			.run(id, title, JSON.stringify(scope), model, now);

		const insertSection = database.prepare(
			`INSERT INTO report_sections (id, report_id, position, heading, body_markdown, source_paths_json)
			 VALUES (?, ?, ?, ?, ?, ?)`
		);
		sections.forEach((section, position) => {
			insertSection.run(
				crypto.randomUUID(),
				id,
				position,
				section.heading,
				section.body_markdown,
				JSON.stringify(section.source_paths)
			);
		});
	});
	tx();
	return id;
}

export function getReport(v: VaultContext, id: string): ReportRow | undefined {
	return getDb(v).prepare('SELECT * FROM reports WHERE id = ?').get(id) as ReportRow | undefined;
}

export function getReportSections(v: VaultContext, reportId: string): ReportSectionRow[] {
	return getDb(v)
		.prepare('SELECT * FROM report_sections WHERE report_id = ? ORDER BY position ASC')
		.all(reportId) as ReportSectionRow[];
}

export function listReports(v: VaultContext): StudyListRow[] {
	return getDb(v)
		.prepare('SELECT id, title, model, created_at FROM reports ORDER BY created_at DESC')
		.all() as StudyListRow[];
}

/** ON DELETE CASCADE (report_sections) handles the rest — see getDb()'s
 * foreign_keys pragma. */
export function deleteReport(v: VaultContext, id: string): void {
	getDb(v).prepare('DELETE FROM reports WHERE id = ?').run(id);
}

export interface MindMapRow {
	id: string;
	title: string;
	scope_json: string;
	model: string;
	created_at: string;
	/** What the topic MEANS — shown on the map's root node. Empty for maps
	 * generated before the root gained a definition. */
	root_summary: string;
}

export interface MindMapNodeRow {
	id: string;
	mindmap_id: string;
	position: number;
	path_json: string;
	source_path: string;
	heading_path: string;
	/** One-sentence explanation of this node, shown as its child in the map.
	 * Empty for nodes generated before summaries existed. */
	summary: string;
}

export interface NewMindMapNode {
	path: string[];
	summary: string;
	source_path: string;
	heading_path: string;
}

export function createMindMap(
	v: VaultContext,
	title: string,
	scope: unknown,
	model: string,
	nodes: NewMindMapNode[],
	rootSummary = ''
): string {
	const id = crypto.randomUUID();
	const now = new Date().toISOString();
	const database = getDb(v);
	const tx = database.transaction(() => {
		database
			.prepare(
				`INSERT INTO mindmaps (id, title, scope_json, model, created_at, root_summary)
				 VALUES (?, ?, ?, ?, ?, ?)`
			)
			.run(id, title, JSON.stringify(scope), model, now, rootSummary);

		const insertNode = database.prepare(
			`INSERT INTO mindmap_nodes (id, mindmap_id, position, path_json, source_path, heading_path, summary)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`
		);
		nodes.forEach((node, position) => {
			insertNode.run(
				crypto.randomUUID(),
				id,
				position,
				JSON.stringify(node.path),
				node.source_path,
				node.heading_path,
				node.summary
			);
		});
	});
	tx();
	return id;
}

export function getMindMap(v: VaultContext, id: string): MindMapRow | undefined {
	return getDb(v).prepare('SELECT * FROM mindmaps WHERE id = ?').get(id) as MindMapRow | undefined;
}

export function getMindMapNodes(v: VaultContext, mindmapId: string): MindMapNodeRow[] {
	return getDb(v)
		.prepare('SELECT * FROM mindmap_nodes WHERE mindmap_id = ? ORDER BY position ASC')
		.all(mindmapId) as MindMapNodeRow[];
}

export function listMindMaps(v: VaultContext): StudyListRow[] {
	return getDb(v)
		.prepare('SELECT id, title, model, created_at FROM mindmaps ORDER BY created_at DESC')
		.all() as StudyListRow[];
}

/** ON DELETE CASCADE (mindmap_nodes) handles the rest — see getDb()'s
 * foreign_keys pragma. */
export function deleteMindMap(v: VaultContext, id: string): void {
	getDb(v).prepare('DELETE FROM mindmaps WHERE id = ?').run(id);
}

export interface SlideDeckRow {
	id: string;
	title: string;
	scope_json: string;
	model: string;
	created_at: string;
	rendered_html: string;
	rendered_css: string;
}

export interface SlideRow {
	id: string;
	deck_id: string;
	position: number;
	layout: string;
	heading: string;
	content_markdown: string;
	notes: string | null;
	source_path: string;
}

export interface NewSlide {
	layout: string;
	heading: string;
	content_markdown: string;
	notes: string | null;
	source_path: string;
}

export function createSlideDeck(
	v: VaultContext,
	title: string,
	scope: unknown,
	model: string,
	slides: NewSlide[],
	rendered: { html: string; css: string }
): string {
	const id = crypto.randomUUID();
	const now = new Date().toISOString();
	const database = getDb(v);
	const tx = database.transaction(() => {
		database
			.prepare(
				`INSERT INTO slidedecks (id, title, scope_json, model, created_at, rendered_html, rendered_css)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`
			)
			.run(id, title, JSON.stringify(scope), model, now, rendered.html, rendered.css);

		const insertSlide = database.prepare(
			`INSERT INTO slides (id, deck_id, position, layout, heading, content_markdown, notes, source_path)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
		);
		slides.forEach((slide, position) => {
			insertSlide.run(
				crypto.randomUUID(),
				id,
				position,
				slide.layout,
				slide.heading,
				slide.content_markdown,
				slide.notes,
				slide.source_path
			);
		});
	});
	tx();
	return id;
}

export function getSlideDeck(v: VaultContext, id: string): SlideDeckRow | undefined {
	return getDb(v).prepare('SELECT * FROM slidedecks WHERE id = ?').get(id) as SlideDeckRow | undefined;
}

/** Selects only the light columns — deliberately not `SELECT *`, since
 * slidedecks also carries rendered_html/rendered_css (a full rendered
 * deck's worth of markup) that a list view has no use for. */
export function listSlideDecks(v: VaultContext): StudyListRow[] {
	return getDb(v)
		.prepare('SELECT id, title, model, created_at FROM slidedecks ORDER BY created_at DESC')
		.all() as StudyListRow[];
}

export function getSlides(v: VaultContext, deckId: string): SlideRow[] {
	return getDb(v)
		.prepare('SELECT * FROM slides WHERE deck_id = ? ORDER BY position ASC')
		.all(deckId) as SlideRow[];
}

/** ON DELETE CASCADE (slides) handles the rest — see getDb()'s foreign_keys
 * pragma. */
export function deleteSlideDeck(v: VaultContext, id: string): void {
	getDb(v).prepare('DELETE FROM slidedecks WHERE id = ?').run(id);
}

// ---- learner model (F1b) ----------------------------------------------------------------------------------------------------

/** One stored answer with everything the evidence rules need (learner-evidence.ts decides what counts) — shared by the
 * learner model and the weak-spot list, so both read the exact same joined data. */
export interface AnswerEvidenceRow {
	item_id: string;
	quiz_id: string;
	answered_at: string;
	given: string;
	is_correct: 0 | 1;
	type: string;
	question: string;
	source_path: string;
	heading_path: string;
	correct_answer: string;
	model_feedback: string | null;
	flagged_at: string | null;
	cognitive_level: string | null;
	options_json: string | null;
}

/** Every stored answer joined to its question. An answer whose quiz was deleted is gone with it (ON DELETE CASCADE). */
export function getAnswerEvidenceRows(v: VaultContext): AnswerEvidenceRow[] {
	return getDb(v)
		.prepare(
			`SELECT aa.item_id AS item_id, qi.quiz_id AS quiz_id, COALESCE(a.finished_at, a.started_at) AS answered_at,
			        aa.given AS given, aa.is_correct AS is_correct, qi.type AS type, qi.question AS question,
			        qi.source_path AS source_path, qi.heading_path AS heading_path, qi.answer AS correct_answer,
			        aa.model_feedback AS model_feedback, qi.flagged_at AS flagged_at,
			        qi.cognitive_level AS cognitive_level, qi.options_json AS options_json
			 FROM attempt_answers aa
			 JOIN attempts a ON a.id = aa.attempt_id
			 JOIN quiz_items qi ON qi.id = aa.item_id`
		)
		.all() as AnswerEvidenceRow[];
}

export interface CardLearnerRow {
	source_path: string;
	domain: string;
	interval_days: number;
	due_at: string;
	reps: number;
	lapses: number;
}

export function getCardsForLearner(v: VaultContext): CardLearnerRow[] {
	return getDb(v).prepare('SELECT source_path, domain, interval_days, due_at, reps, lapses FROM cards').all() as CardLearnerRow[];
}

/** A card with enough of its content to show as a weak spot — `CardLearnerRow` only carries what the mastery number needs. */
export interface CardErrorRow {
	id: string;
	front: string;
	back: string;
	source_path: string;
	heading_path: string;
	domain: string;
	interval_days: number;
	due_at: string;
	lapses: number;
}

/** Only cards forgotten at least once (`lapses > 0`): a card that has never been forgotten is not a weak spot. */
export function getCardsForErrors(v: VaultContext): CardErrorRow[] {
	return getDb(v)
		.prepare('SELECT id, front, back, source_path, heading_path, domain, interval_days, due_at, lapses FROM cards WHERE lapses > 0')
		.all() as CardErrorRow[];
}

export interface SkillStateRow {
	id: string;
	skill_id: string;
	observed_at: string;
	mastery: number | null;
	mastery_basic: number | null;
	mastery_applied: number | null;
	retention: number | null;
	evidence_count: number;
	retention_cards: number;
	confidence: string;
	origin: string;
}

const round3 = (n: number | null) => (n === null ? null : Math.round(n * 1000) / 1000);

/**
 * Appends what a profile says to the append-only history (skill_state: an old value is never overwritten, so progress over time can
 * be read back later). Only nodes with something to say are written, and a node whose numbers are unchanged since its last row
 * (to three decimals, same evidence count) is skipped, so running it twice in a row writes nothing the second time.
 * Never called by a page load: a snapshot is an explicit act (scripts/learner-report.ts --snapshot).
 */
export function appendSkillSnapshot(v: VaultContext, profile: LearnerProfile): { written: number; skipped: number } {
	const database = getDb(v);
	const upsertNode = database.prepare(
		`INSERT INTO skill_nodes (id, name, kind, domains_json, source_path, created_at) VALUES (?, ?, ?, ?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET name = excluded.name, kind = excluded.kind, domains_json = excluded.domains_json, source_path = excluded.source_path`
	);
	const latest = database.prepare('SELECT * FROM skill_state WHERE skill_id = ? ORDER BY observed_at DESC, rowid DESC LIMIT 1');
	const insert = database.prepare(
		`INSERT INTO skill_state (id, skill_id, observed_at, mastery, mastery_basic, mastery_applied, retention, evidence_count, retention_cards, confidence, origin)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OBSERVED')`
	);
	let written = 0;
	let skipped = 0;
	const tx = database.transaction(() => {
		for (const node of profile.nodes) {
			if (node.quiz.mastery === null && node.retention.retention === null) continue;
			upsertNode.run(node.id, node.name, node.kind, JSON.stringify(node.domains ?? []), node.sourcePath ?? null, profile.generatedAt);
			const row = {
				mastery: round3(node.quiz.mastery),
				basic: round3(node.bands?.basic.mastery ?? null),
				applied: round3(node.bands?.applied.mastery ?? null),
				retention: round3(node.retention.retention)
			};
			const prev = latest.get(node.id) as SkillStateRow | undefined;
			if (
				prev &&
				round3(prev.mastery) === row.mastery &&
				round3(prev.mastery_basic) === row.basic &&
				round3(prev.mastery_applied) === row.applied &&
				round3(prev.retention) === row.retention &&
				prev.evidence_count === node.quiz.count &&
				prev.retention_cards === node.retention.cards
			) {
				skipped++;
				continue;
			}
			insert.run(crypto.randomUUID(), node.id, profile.generatedAt, row.mastery, row.basic, row.applied, row.retention, node.quiz.count, node.retention.cards, node.quiz.confidence);
			written++;
		}
	});
	tx();
	return { written, skipped };
}

/** The recorded history of one node, oldest first. */
export function getSkillHistory(v: VaultContext, skillId: string, limit = 200): SkillStateRow[] {
	// The newest `limit` rows, then oldest first. rowid breaks ties between rows written at the same instant; a subquery does not expose
	// it, so it is carried out as `r`.
	return getDb(v)
		.prepare(
			`SELECT id, skill_id, observed_at, mastery, mastery_basic, mastery_applied, retention, evidence_count, retention_cards, confidence, origin
			 FROM (SELECT rowid AS r, * FROM skill_state WHERE skill_id = ? ORDER BY observed_at DESC, rowid DESC LIMIT ?)
			 ORDER BY observed_at ASC, r ASC`
		)
		.all(skillId, limit) as SkillStateRow[];
}
