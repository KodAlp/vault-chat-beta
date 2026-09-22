import { isAnswered } from '../study-answers';
import { isCognitiveLevel } from '../cognitive-levels';
import type { EvidencePoint, EvidenceType } from '../learner-model';
import { questionKey } from './quiz-dedupe';

/**
 * Which stored quiz answers count as evidence about what a person knows. Pure (the SQL lives in study-db.ts), so the rules are
 * tested without a database. Each rule exists because of something measured in the real study.db:
 *
 *  - a blank answer is never evidence, whatever `is_correct` says: 84 of 97 stored answers were blank (the quiz page sends every
 *    question on finish) and the model that graded 21 blank open answers called 6 of them correct;
 *  - a question the user flagged as faulty ("Bu soru hatalı") is not evidence: about 1 generated answer key in 30 was plainly wrong
 *    and about 1 question in 9 was faulty or ambiguous, and only the person answering can tell which;
 *  - a multiple-choice question stored without options is not evidence: an older generator left `options_json` empty for some
 *    items, so "the answer matched" can mean the grader compared free text to a label (`"2e^2"` vs `"2e²"`) rather than the
 *    person actually choosing among alternatives — 4 of the 13 real answers in the first study.db were this case;
 *  - one question is one piece of evidence: 18 of the 129 stored questions were verbatim repeats of another, and retaking the same
 *    quiz five times must not make five pieces of evidence out of one. For each distinct question the LATEST answered attempt
 *    counts, because it says the most about what the person knows now.
 */

export interface AnswerRow {
	itemId: string;
	/** The quiz this question belongs to — needed to call the "Bu soru hatalı" route, which is scoped by quiz id. */
	quizId: string;
	/** ISO time the attempt was finished (or started, if it never was). */
	answeredAt: string;
	given: string;
	isCorrect: boolean;
	type: string;
	question: string;
	sourcePath: string;
	headingPath: string;
	/** The stored answer key (option text for MC, "true"/"false" for TF, the reference text for open). */
	correctAnswer: string;
	/** Set only for a model-graded open answer. */
	modelFeedback: string | null;
	/** Set when the user flagged the question as faulty. */
	flaggedAt: string | null;
	cognitiveLevel: string | null;
	/** Parsed `quiz_items.options_json`; null/empty means the question was stored without answer choices. */
	options: readonly string[] | null;
}

const TYPES: readonly string[] = ['multiple_choice', 'true_false', 'open'];

/**
 * Whether a stored answer counts as evidence at all — shared by `pickEvidence` (F1b, what the person knows) and
 * `buildWeakSpots` (F2, where they got it wrong): both must agree on what a "real" answer is, or the two features would
 * quietly disagree about the same row.
 */
export function isCountableAnswer(row: Pick<AnswerRow, 'given' | 'flaggedAt' | 'type' | 'options'>): boolean {
	if (!isAnswered(row.given)) return false;
	if (row.flaggedAt !== null) return false;
	if (!TYPES.includes(row.type)) return false;
	if (row.type === 'multiple_choice' && (!row.options || row.options.length === 0)) return false;
	return true;
}

export function pickEvidence(rows: readonly AnswerRow[], domainsOf: (sourcePath: string) => string[]): EvidencePoint[] {
	const latest = new Map<string, AnswerRow>();
	for (const row of rows) {
		if (!isCountableAnswer(row)) continue;
		const key = `${row.sourcePath}::${questionKey(row.question)}`;
		const prev = latest.get(key);
		// >= so that, on identical timestamps, the row that came later in the input wins
		if (!prev || Date.parse(row.answeredAt) >= Date.parse(prev.answeredAt)) latest.set(key, row);
	}
	return [...latest.entries()].map(([key, row]) => ({
		key,
		sourcePath: row.sourcePath,
		domains: domainsOf(row.sourcePath),
		type: row.type as EvidenceType,
		correct: row.isCorrect,
		at: row.answeredAt,
		level: isCognitiveLevel(row.cognitiveLevel) ? row.cognitiveLevel : null
	}));
}
