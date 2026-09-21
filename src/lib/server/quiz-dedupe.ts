/**
 * The last-line safety net against a repeated quiz question. Pure, dependency-free.
 *
 * Deliberately EXACT, not fuzzy. Measured on the real vault: an embedding cosine cannot tell a paraphrased duplicate
 * (0.94-0.96) from the legitimate "same template, different numbers" family ("f'(x) at x=1 of 1/x^2" vs "at x=3 of 1/x^3",
 * 0.91-0.94), and token Jaccard scores those template questions 1.00. A fuzzy gate would delete real questions. The actual
 * fix is prevention — batches that see different source parts (quiz-batch.ts) — so all this catches is a verbatim repeat.
 *
 * The key keeps digits and math symbols untouched on purpose: "∫ x² e^x dx" and "∫ x² dx" are different questions.
 */

/**
 * Case, whitespace, Unicode form and trailing punctuation are ignored; everything else (digits, symbols) counts.
 * Turkish "İ" lower-cases to "i" + a combining dot (U+0307) under the default rules, which would make "NEDİR" and
 * "nedir" different keys, so the dot is dropped after lower-casing.
 */
export function questionKey(question: string): string {
	return question
		.normalize('NFC')
		.toLowerCase()
		.replace(/̇/g, '')
		.replace(/\s+/g, ' ')
		.replace(/[\s.?!:;,]+$/u, '')
		.trim();
}

export interface DedupeResult<T> {
	kept: T[];
	dropped: T[];
}

/**
 * Keeps the first occurrence of each question and drops later repeats, across types (an MC stem reused as a true/false
 * statement is the same question). `existing` are questions already accepted elsewhere (a top-up batch is checked against
 * the quiz so far).
 */
export function dedupeItems<T extends { question: string }>(items: readonly T[], existing: readonly string[] = []): DedupeResult<T> {
	const seen = new Set(existing.map(questionKey));
	const kept: T[] = [];
	const dropped: T[] = [];
	for (const item of items) {
		const key = questionKey(item.question);
		if (seen.has(key)) dropped.push(item);
		else {
			seen.add(key);
			kept.push(item);
		}
	}
	return { kept, dropped };
}
