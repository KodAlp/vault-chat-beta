import Database from 'better-sqlite3';
import type { CardSchedule } from './schedule';
import type { VaultContext } from './vaults';
import { logAppEvent } from './app-log';

/** Shared shape for every "what's been generated in this vault" list
 * (Faz 13) — id/title/model/created_at is the one thing all five
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
/** No ALTER-guard block here yet, unlike chats-db.ts — because no column has
 * been added to any of these tables since they first shipped. The moment one
 * is (e.g. a future `cards.suspended` flag), add it to the `CREATE TABLE`
 * below AND to an `ensureColumns(instance, table, {...})` call right after
 * `instance.exec(...)`, same as chats-db.ts's `vault_id`/`included_paths_json`
 * — otherwise every pre-existing study.db on disk fails with "no such column"
 * the instant that code path runs. See sqlite-schema.ts's doc comment. */
function getDb(v: VaultContext): Database.Database {
	let db = dbCache.get(v.id);
	if (db) return db;
	const instance = new Database(v.studyDbPath);
	// A pragma/exec failure here must not leave an open handle uncached — see
	// the identical fix (and its EBUSY rationale) in chats-db.ts's getDb().
	try {
		instance.pragma('journal_mode = WAL');
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
				heading_path TEXT NOT NULL
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
				created_at TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS mindmap_nodes (
				id TEXT PRIMARY KEY,
				mindmap_id TEXT NOT NULL REFERENCES mindmaps(id) ON DELETE CASCADE,
				position INTEGER NOT NULL,
				path_json TEXT NOT NULL,
				source_path TEXT NOT NULL,
				heading_path TEXT NOT NULL
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
				content_markdown TEXT NOT NULL,
				source_path TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_slides_deck_id ON slides(deck_id);
		`);
	} catch (err) {
		instance.close();
		const message = err instanceof Error ? err.message : 'Bilinmeyen hata';
		logAppEvent({ kind: 'db_error', message: `study.db init başarısız (${v.id}): ${message}` });
		throw err;
	}
	dbCache.set(v.id, instance);
	return instance;
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
			`INSERT INTO quiz_items (id, quiz_id, position, type, question, options_json, answer, explanation, source_path, heading_path)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
				item.heading_path
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
export function listQuizzes(v: VaultContext): StudyListRow[] {
	return getDb(v)
		.prepare('SELECT id, title, model, created_at FROM quizzes ORDER BY created_at DESC')
		.all() as StudyListRow[];
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

export function getDueCount(v: VaultContext, nowIso: string): number {
	const row = getDb(v)
		.prepare('SELECT COUNT(*) AS n FROM cards WHERE due_at <= ?')
		.get(nowIso) as { n: number };
	return row.n;
}

export function getDueCards(v: VaultContext, nowIso: string, limit: number): CardRow[] {
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

export interface MindMapRow {
	id: string;
	title: string;
	scope_json: string;
	model: string;
	created_at: string;
}

export interface MindMapNodeRow {
	id: string;
	mindmap_id: string;
	position: number;
	path_json: string;
	source_path: string;
	heading_path: string;
}

export interface NewMindMapNode {
	path: string[];
	source_path: string;
	heading_path: string;
}

export function createMindMap(
	v: VaultContext,
	title: string,
	scope: unknown,
	model: string,
	nodes: NewMindMapNode[]
): string {
	const id = crypto.randomUUID();
	const now = new Date().toISOString();
	const database = getDb(v);
	const tx = database.transaction(() => {
		database
			.prepare(`INSERT INTO mindmaps (id, title, scope_json, model, created_at) VALUES (?, ?, ?, ?, ?)`)
			.run(id, title, JSON.stringify(scope), model, now);

		const insertNode = database.prepare(
			`INSERT INTO mindmap_nodes (id, mindmap_id, position, path_json, source_path, heading_path)
			 VALUES (?, ?, ?, ?, ?, ?)`
		);
		nodes.forEach((node, position) => {
			insertNode.run(
				crypto.randomUUID(),
				id,
				position,
				JSON.stringify(node.path),
				node.source_path,
				node.heading_path
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
	content_markdown: string;
	source_path: string;
}

export interface NewSlide {
	content_markdown: string;
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
			`INSERT INTO slides (id, deck_id, position, content_markdown, source_path)
			 VALUES (?, ?, ?, ?, ?)`
		);
		slides.forEach((slide, position) => {
			insertSlide.run(crypto.randomUUID(), id, position, slide.content_markdown, slide.source_path);
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
