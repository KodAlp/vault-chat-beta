import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { computeLearnerProfile, computeWeakSpots } from './learner-store';
import {
	appendSkillSnapshot, closeVaultStudyDb, createAttempt, createDeck, createQuiz, finishAttempt, getAnswerEvidenceRows, getDeckCards,
	getQuizItems, getSkillHistory, insertAttemptAnswer, setQuizItemFlagged, updateCardSchedule
} from './study-db';
import type { VaultContext } from './vaults';

const NOW = new Date('2026-09-21T12:00:00.000Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

/** A throwaway vault on disk: its own study.db and (optionally) index.db. Cleaned up even when an assertion throws. */
function withVault(fn: (v: VaultContext, dir: string) => void, opts: { index?: Record<string, string[]> | null } = { index: {} }) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'learner-'));
	const v: VaultContext = { id: `t-${Math.random().toString(36).slice(2)}`, name: 't', dir, libraryRoot: dir, indexDbPath: path.join(dir, 'index.db'), studyDbPath: path.join(dir, 'study.db') };
	if (opts.index) {
		const idx = new Database(v.indexDbPath);
		idx.exec('CREATE TABLE files (path TEXT PRIMARY KEY, domains_json TEXT NOT NULL DEFAULT \'[]\')');
		for (const [p, d] of Object.entries(opts.index)) idx.prepare('INSERT INTO files (path, domains_json) VALUES (?, ?)').run(p, JSON.stringify(d));
		idx.close();
	}
	try {
		fn(v, dir);
	} finally {
		closeVaultStudyDb(v.id);
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

/** Stores one finished attempt at a chosen time; `answers` maps item position -> what was given / whether it was graded correct. */
function attempt(v: VaultContext, quizId: string, at: string, answers: Record<number, { given: string; correct: boolean }>) {
	const items = getQuizItems(v, quizId);
	const id = createAttempt(v, quizId);
	for (const [pos, a] of Object.entries(answers)) insertAttemptAnswer(v, { attemptId: id, itemId: items[Number(pos)].id, given: a.given, isCorrect: a.correct });
	finishAttempt(v, id, 0.5);
	const raw = new Database(v.studyDbPath);
	raw.prepare('UPDATE attempts SET finished_at = ?, started_at = ? WHERE id = ?').run(at, at, id);
	raw.close();
}

const item = (over: Record<string, unknown>) => ({ type: 'open' as const, question: 'q', answer: 'a', explanation: 'e', source_path: 'wiki/os/a.md', heading_path: 'A > x', ...over });

test('end to end on real SQL: blank, flagged and duplicate answers do not count; the latest attempt of a question does', () => {
	withVault((v) => {
		const quiz = createQuiz(v, 't', {}, 'm', [
			item({ question: 'Süreç grubu nedir?' }), // 0
			item({ question: 'Zamanlayıcı ne yapar?', type: 'multiple_choice', options: ['a', 'b', 'c', 'd', 'e'], answer: 'a' }), // 1: answered blank
			item({ question: 'Türev doğrusaldır', type: 'true_false', answer: 'true', source_path: 'wiki/math/b.md' }), // 2
			item({ question: 'Hatalı soru', source_path: 'wiki/math/b.md' }), // 3: flagged
			item({ question: ' süreç GRUBU nedir? ' }) // 4: a verbatim twin of 0
		]);
		const items = getQuizItems(v, quiz);
		setQuizItemFlagged(v, items[3].id, true);
		// older attempt: the twin answered wrong; newer attempt: the original answered right, a blank one, a wrong true/false, a flagged one
		attempt(v, quiz, daysAgo(20), { 4: { given: 'yanlış', correct: false } });
		attempt(v, quiz, daysAgo(6), { 0: { given: 'doğru', correct: true }, 1: { given: '', correct: true }, 2: { given: 'false', correct: false }, 3: { given: 'x', correct: false } });

		const p = computeLearnerProfile(v, NOW);
		const by = (id: string) => p.nodes.find((n) => n.id === id)!;
		assert.equal(by('overall').quiz.count, 2, 'q0/q4 are one question, q1 blank, q3 flagged');
		assert.equal(by('domain:os').quiz.count, 1);
		assert.equal(by('domain:math').quiz.count, 1);
		const w = Math.pow(0.5, 6 / 45);
		assert.ok(Math.abs(by('domain:os').quiz.mastery! - (w + 1) / (w + 2)) < 1e-9, 'the LATEST answer (right) counts, not the older wrong twin');
		const wTf = Math.pow(0.5, 6 / 45) * 0.5;
		assert.ok(Math.abs(by('domain:math').quiz.mastery! - 1 / (wTf + 2)) < 1e-9, 'a wrong true/false answer');
		assert.equal(by('note:wiki/os/a.md').quiz.count, 1);
		assert.equal(by('overall').quiz.reliable, false, 'two answers are not enough to call a number reliable');
	}, { index: { 'wiki/os/a.md': ['os'], 'wiki/math/b.md': ['math'] } });
});

test('cards give retention on the notes they belong to, kept apart from the quiz mastery', () => {
	withVault((v) => {
		const deck = createDeck(v, 'd', {}, 'm', [
			{ front: 'f1', back: 'b1', source_path: 'wiki/os/a.md', heading_path: 'A', domain: 'os', level: 'basic' },
			{ front: 'f2', back: 'b2', source_path: 'wiki/os/a.md', heading_path: 'A', domain: 'os', level: 'basic' }
		]);
		const cards = getDeckCards(v, deck);
		updateCardSchedule(v, cards[0].id, { ease: 2.5, interval_days: 10, due_at: NOW.toISOString(), reps: 3, lapses: 0 });
		const p = computeLearnerProfile(v, NOW);
		const osNode = p.nodes.find((n) => n.id === 'domain:os')!;
		assert.equal(osNode.retention.cards, 1, 'the never-reviewed card is not counted');
		assert.ok(Math.abs(osNode.retention.retention! - 0.9) < 1e-9);
		assert.equal(osNode.quiz.mastery, null, 'no quiz answers: no mastery, not 0.5');
	}, { index: { 'wiki/os/a.md': ['os'] } });
});

test('a vault with no index puts every note in the unknown domain and still computes', () => {
	withVault((v) => {
		const quiz = createQuiz(v, 't', {}, 'm', [item({ question: 'x' })]);
		attempt(v, quiz, daysAgo(1), { 0: { given: 'y', correct: true } });
		const p = computeLearnerProfile(v, NOW);
		assert.equal(p.nodes.find((n) => n.id === 'domain:(unknown)')?.quiz.count, 1);
		assert.equal(p.nodes[0].quiz.count, 1);
	}, { index: null });
});

test('an old study.db that predates the learner tables is upgraded in place and reads as empty', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'learner-old-'));
	const v: VaultContext = { id: `old-${Math.random().toString(36).slice(2)}`, name: 't', dir, libraryRoot: dir, indexDbPath: path.join(dir, 'index.db'), studyDbPath: path.join(dir, 'study.db') };
	try {
		const old = new Database(v.studyDbPath);
		old.exec("CREATE TABLE quizzes (id TEXT PRIMARY KEY, title TEXT NOT NULL, scope_json TEXT NOT NULL, model TEXT NOT NULL, created_at TEXT NOT NULL); INSERT INTO quizzes VALUES ('q','t','{}','m','2026-01-01T00:00:00.000Z')");
		old.close();
		assert.deepEqual(getAnswerEvidenceRows(v), []);
		const p = computeLearnerProfile(v, NOW);
		assert.equal(p.nodes.length, 1);
		const check = new Database(v.studyDbPath, { readonly: true });
		const tables = check.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('skill_nodes','skill_state')").all();
		check.close();
		assert.equal(tables.length, 2);
	} finally {
		closeVaultStudyDb(v.id);
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('a snapshot is append-only: a second run writes nothing, new evidence writes a new row, old rows stay', () => {
	withVault((v) => {
		const quiz = createQuiz(v, 't', {}, 'm', [item({ question: 'a1' }), item({ question: 'a2' })]);
		attempt(v, quiz, daysAgo(2), { 0: { given: 'x', correct: true } });

		const first = appendSkillSnapshot(v, computeLearnerProfile(v, NOW));
		assert.ok(first.written > 0);
		assert.equal(first.skipped, 0);
		const again = appendSkillSnapshot(v, computeLearnerProfile(v, NOW));
		assert.equal(again.written, 0, 'nothing changed');
		assert.equal(again.skipped, first.written);

		attempt(v, quiz, daysAgo(0), { 1: { given: 'y', correct: false } });
		const later = new Date(NOW.getTime() + 60_000);
		const third = appendSkillSnapshot(v, computeLearnerProfile(v, later));
		assert.ok(third.written > 0);

		const history = getSkillHistory(v, 'overall');
		assert.equal(history.length, 2);
		assert.equal(history[0].evidence_count, 1);
		assert.equal(history[1].evidence_count, 2);
		assert.ok(history[0].observed_at < history[1].observed_at);
		assert.equal(history[0].origin, 'OBSERVED');
		assert.ok(history[1].mastery! < history[0].mastery!, 'a wrong answer lowered the estimate');
	});
});

test('end to end on real SQL: computeWeakSpots groups a wrong quiz answer and a forgotten card by note and heading', () => {
	withVault((v) => {
		const quiz = createQuiz(v, 't', {}, 'm', [
			item({ question: 'Zamanlayıcı ne yapar?', type: 'multiple_choice', options: ['a', 'b', 'c', 'd', 'e'], answer: 'a', heading_path: 'Scheduling' }), // 0: wrong
			item({ question: 'Süreç grubu nedir?', heading_path: 'Scheduling' }), // 1: right, never a weak spot
			item({ question: 'Hatalı soru', heading_path: 'Scheduling' }) // 2: flagged wrong answer, excluded
		]);
		const items = getQuizItems(v, quiz);
		setQuizItemFlagged(v, items[2].id, true);
		attempt(v, quiz, daysAgo(1), { 0: { given: 'b', correct: false }, 1: { given: 'doğru', correct: true }, 2: { given: 'x', correct: false } });

		const deck = createDeck(v, 'd', {}, 'm', [{ front: 'f1', back: 'b1', source_path: 'wiki/os/a.md', heading_path: 'Scheduling', domain: 'os', level: 'basic' }]);
		const cards = getDeckCards(v, deck);
		updateCardSchedule(v, cards[0].id, { ease: 2.5, interval_days: 0, due_at: daysAgo(0), reps: 1, lapses: 1 });

		const spots = computeWeakSpots(v);
		assert.equal(spots.length, 1, 'one note+heading, one weak spot');
		const spot = spots[0];
		assert.equal(spot.sourcePath, 'wiki/os/a.md');
		assert.equal(spot.headingPath, 'Scheduling');
		assert.equal(spot.openErrors, 1, 'only the wrong, unflagged MC question counts');
		assert.equal(spot.forgottenCards, 1);
		assert.equal(spot.errors.length, 2, 'the quiz error and the forgotten card, not the right answer or the flagged one');
	}, { index: { 'wiki/os/a.md': ['os'] } });
});

test('a node with nothing to say (no evidence, no reviewed card) is not written', () => {
	withVault((v) => {
		const r = appendSkillSnapshot(v, computeLearnerProfile(v, NOW));
		assert.equal(r.written, 0);
		assert.deepEqual(getSkillHistory(v, 'overall'), []);
	});
});
