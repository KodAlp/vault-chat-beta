import type { AnswerRow } from './learner-evidence';
import { isCountableAnswer } from './learner-evidence';
import { questionKey } from './quiz-dedupe';

/**
 * Weak spots — notes where the person keeps getting a question wrong or keeps forgetting a card, grouped by
 * `(source_path, heading_path)`. Pure, like learner-model.ts; the SQL lives in study-db.ts.
 *
 * Deliberately NO stored `errors` table. A weak spot is computed fresh from the same answers and cards every time,
 * exactly like the learner model (F1b): a stored table would need to be kept in sync with edits, deletions and
 * re-answers, and the one thing a stored row would add — a user "this isn't really wrong" flag — already exists as
 * the "Bu soru hatalı" flag on the question itself, which `isCountableAnswer` already excludes.
 *
 * What counts as wrong here reuses `isCountableAnswer` from learner-evidence.ts on purpose: the learner profile and the weak-spot list read the same
 * stored answers, and if they disagreed about what a "real" answer is (a blank counted as wrong here but not there,
 * say) the two features would tell two different stories about the same quiz. A question is grouped and deduplicated
 * exactly like F1b too (`questionKey`), so five retakes of the same quiz are one weak spot with one wrong-count, not
 * five.
 *
 * Measured on the real study.db: of 97 stored answers only 8 were real, ungraded-blank wrong
 * answers, and at least half of those were not the person's fault (a stored question without options, or a question
 * with more than one defensible correct option) — this module cannot tell those apart, which is exactly why "Bu soru
 * hatalı" stays the escape hatch rather than something this module tries to guess. Reviewed cards were a much richer
 * signal: 20 of 40 had been forgotten (`lapses`) at least once.
 */

/** A card that has been forgotten at least once (`lapses > 0`; study-db.ts filters this at the query). */
export interface CardErrorPoint {
	id: string;
	front: string;
	back: string;
	sourcePath: string;
	headingPath: string;
	domains: string[];
	intervalDays: number;
	lapses: number;
	/** The card's own schedule timestamp — the closest thing to "last touched" the schema stores (no review log). */
	dueAt: string;
}

export interface ErrorItem {
	kind: 'quiz' | 'card';
	id: string;
	/** quiz kind only: the "Bu soru hatalı" route is scoped by quiz id. */
	quizId?: string;
	/** quiz kind only. */
	type?: string;
	/** The question text (quiz) or the card's front (card). */
	question: string;
	/** card kind only: shown so a forgotten card still tells the reader the answer. */
	back?: string;
	/** What was given vs. what was right, only while still wrong (null once resolved — there is nothing current to show).
	 * Raw text: quiz-options.ts already strips letter labels ("A) ") before storage, a leading one is stripped again here
	 * only as a defence for historical rows written before that existed. */
	confusion: { chose: string; correct: string } | null;
	/** Only ever set for a currently-wrong open question that a model graded. */
	modelFeedback?: string | null;
	/** Quiz: how many distinct attempts of this question were wrong. Card: `lapses`. */
	wrongCount: number;
	/** Quiz: the latest attempt was correct. Card: not lapsed since its last review (`intervalDays > 0`). */
	resolved: boolean;
	lastAt: string;
}

export interface WeakSpot {
	id: string;
	sourcePath: string;
	headingPath: string;
	noteName: string;
	domains: string[];
	openErrors: number;
	resolvedErrors: number;
	lapsedCards: number;
	forgottenCards: number;
	lastSeen: string;
	errors: ErrorItem[];
}

function noteName(path: string): string {
	return (path.split('/').pop() ?? path).replace(/\.[^.]+$/, '');
}

const LABEL = /^\s*[A-Ea-e][)\.:]\s*/;
const stripLabel = (s: string) => s.replace(LABEL, '').trim();

/** One question's full answer history (every countable attempt, any quiz it was regenerated into) folded into one error item,
 * or null when it was never actually gotten wrong. */
function quizErrorItem(rows: readonly AnswerRow[]): ErrorItem | null {
	const sorted = [...rows].sort((a, b) => Date.parse(a.answeredAt) - Date.parse(b.answeredAt));
	const wrongCount = sorted.filter((r) => !r.isCorrect).length;
	if (wrongCount === 0) return null;
	const latest = sorted[sorted.length - 1];
	const resolved = latest.isCorrect;
	return {
		kind: 'quiz',
		id: latest.itemId,
		quizId: latest.quizId,
		type: latest.type,
		question: latest.question,
		confusion: resolved ? null : { chose: stripLabel(latest.given), correct: stripLabel(latest.correctAnswer) },
		modelFeedback: !resolved && latest.type === 'open' ? latest.modelFeedback : undefined,
		wrongCount,
		resolved,
		lastAt: latest.answeredAt
	};
}

function cardErrorItem(card: CardErrorPoint): ErrorItem {
	return {
		kind: 'card',
		id: card.id,
		question: card.front,
		back: card.back,
		confusion: null,
		wrongCount: card.lapses,
		resolved: card.intervalDays > 0,
		lastAt: card.dueAt
	};
}

export function buildWeakSpots(input: {
	answers: readonly AnswerRow[];
	cards: readonly CardErrorPoint[];
	domainsOf: (sourcePath: string) => string[];
}): WeakSpot[] {
	const byQuestion = new Map<string, AnswerRow[]>();
	for (const row of input.answers) {
		if (!isCountableAnswer(row)) continue;
		const key = `${row.sourcePath}::${questionKey(row.question)}`;
		const list = byQuestion.get(key);
		if (list) list.push(row);
		else byQuestion.set(key, [row]);
	}

	const spots = new Map<string, WeakSpot>();
	const spotFor = (sourcePath: string, headingPath: string): WeakSpot => {
		const key = `${sourcePath}::${headingPath}`;
		let s = spots.get(key);
		if (!s) {
			s = { id: key, sourcePath, headingPath, noteName: noteName(sourcePath), domains: input.domainsOf(sourcePath), openErrors: 0, resolvedErrors: 0, lapsedCards: 0, forgottenCards: 0, lastSeen: '', errors: [] };
			spots.set(key, s);
		}
		return s;
	};
	const touch = (s: WeakSpot, at: string) => {
		if (Date.parse(at) > Date.parse(s.lastSeen || '1970-01-01T00:00:00.000Z')) s.lastSeen = at;
	};

	for (const rows of byQuestion.values()) {
		const item = quizErrorItem(rows);
		if (!item) continue;
		const first = rows[0];
		const s = spotFor(first.sourcePath, first.headingPath);
		s.errors.push(item);
		if (item.resolved) s.resolvedErrors++;
		else s.openErrors++;
		touch(s, item.lastAt);
	}

	for (const card of input.cards) {
		const s = spotFor(card.sourcePath, card.headingPath);
		s.errors.push(cardErrorItem(card));
		s.lapsedCards++;
		if (!(card.intervalDays > 0)) s.forgottenCards++;
		touch(s, card.dueAt);
	}

	const list = [...spots.values()].filter((s) => s.errors.length > 0);
	// most open errors first — that is where a look actually helps right now; ties broken by how recently it came up
	list.sort((a, b) => b.openErrors - a.openErrors || Date.parse(b.lastSeen) - Date.parse(a.lastSeen));
	for (const s of list) s.errors.sort((a, b) => Number(a.resolved) - Number(b.resolved) || Date.parse(b.lastAt) - Date.parse(a.lastAt));
	return list;
}
