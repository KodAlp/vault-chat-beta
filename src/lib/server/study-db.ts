import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { env } from '$env/dynamic/private';

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

let db: Database.Database | undefined;

/** Separate from chats.db/vault-index.db — generated study material, its own
 * lifecycle (quizzes/cards get created, retaken, eventually pruned by the
 * user), not part of either conversation history or the regenerable index. */
function getDb(): Database.Database {
	if (!db) {
		const dbPath = env.STUDY_DB_PATH ?? path.join('data', 'study.db');
		fs.mkdirSync(path.dirname(dbPath), { recursive: true });
		db = new Database(dbPath);
		db.pragma('journal_mode = WAL');
		db.exec(`
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
		`);
	}
	return db;
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

export function createQuiz(title: string, scope: unknown, model: string, items: NewQuizItem[]): string {
	const id = crypto.randomUUID();
	const now = new Date().toISOString();
	const database = getDb();
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

export function getQuiz(id: string): QuizRow | undefined {
	return getDb().prepare('SELECT * FROM quizzes WHERE id = ?').get(id) as QuizRow | undefined;
}

export function getQuizItems(quizId: string): QuizItemRow[] {
	return getDb()
		.prepare('SELECT * FROM quiz_items WHERE quiz_id = ? ORDER BY position ASC')
		.all(quizId) as QuizItemRow[];
}

export function getQuizItem(id: string): QuizItemRow | undefined {
	return getDb().prepare('SELECT * FROM quiz_items WHERE id = ?').get(id) as QuizItemRow | undefined;
}

export function createAttempt(quizId: string): string {
	const id = crypto.randomUUID();
	getDb()
		.prepare('INSERT INTO attempts (id, quiz_id, started_at) VALUES (?, ?, ?)')
		.run(id, quizId, new Date().toISOString());
	return id;
}

export function getAttempt(id: string): AttemptRow | undefined {
	return getDb().prepare('SELECT * FROM attempts WHERE id = ?').get(id) as AttemptRow | undefined;
}

export function finishAttempt(id: string, score: number): void {
	getDb()
		.prepare('UPDATE attempts SET finished_at = ?, score = ? WHERE id = ?')
		.run(new Date().toISOString(), score, id);
}

export function insertAttemptAnswer(input: {
	attemptId: string;
	itemId: string;
	given: string;
	isCorrect: boolean;
	modelFeedback?: string | null;
}): void {
	getDb()
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

export function getAttemptAnswers(attemptId: string): AttemptAnswerRow[] {
	return getDb()
		.prepare('SELECT * FROM attempt_answers WHERE attempt_id = ?')
		.all(attemptId) as AttemptAnswerRow[];
}
