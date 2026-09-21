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
