/**
 * Whether a submitted quiz answer is an actual answer. The quiz page sends EVERY question on
 * finish — the ones left blank as `given: ''` — so an empty string means "skipped", not "wrong"
 * and above all not "correct".
 *
 * Why this exists, measured on the real study.db: 84 of 97 stored answers were blank, and 6 of
 * the 21 blank OPEN answers were stored as correct ("Doğru cevap! İntegralin sonucu doğru
 * hesaplanmış" — for an answer nobody wrote): the open-question grader is a model, and a model
 * asked to grade an empty answer against a reference sometimes just approves it. Blank answers
 * must therefore never reach the grader, and anything that learns from answers (the learner
 * model) must not count a blank as evidence either way, whatever `is_correct` says.
 *
 * Pure and dependency-free (shared by the attempts route and the learner model, and runnable
 * under plain `tsx --test`).
 */
export function isAnswered(given: string | null | undefined): boolean {
	return typeof given === 'string' && given.trim().length > 0;
}

export interface ScoredItem {
	isCorrect: boolean;
	/** The user marked the question itself as faulty ("Bu soru hatalı"). */
	flagged?: boolean;
}

/**
 * The score with the questions the user flagged as faulty taken out of BOTH the numerator and the denominator: a question
 * whose answer key is wrong should not count against the person who answered it correctly. (About 1 in 30 of the generated
 * answer keys was definitely wrong and about 1 in 9 questions was faulty, ambiguous or source-specific nonsense — see the F1a
 * measurements — and only the user can tell which.) `counted` is 0 when everything is flagged; the score is then 0.
 */
export function scoreExcludingFlagged(items: readonly ScoredItem[]): { score: number; correct: number; counted: number; excluded: number } {
	const counted = items.filter((i) => !i.flagged);
	const correct = counted.filter((i) => i.isCorrect).length;
	return { score: counted.length > 0 ? correct / counted.length : 0, correct, counted: counted.length, excluded: items.length - counted.length };
}
