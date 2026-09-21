/**
 * Order of a multiple-choice question's options. Measured on 88 generated questions (two independent sets) the correct option was
 * not spread over the five slots: 25/29/19/7/8 for A..E (chi-square 22.2, df 4, p < 0.001), and 18/8/3/3/0 on the 32 older stored
 * ones. A learner who has noticed that "it is usually A or B" is guessing better than chance, which also breaks the learner
 * model's guess-rate weighting (it assumes a uniform guess). Answers are stored and graded by option TEXT, so shuffling after
 * validation is safe. Pure and dependency-free.
 */

const LETTER_LABEL = /^\s*[A-Ea-e][)\.:]\s+/;

/** Fisher-Yates on a copy; `rng` returns [0, 1) and is injectable so tests are deterministic. */
export function shuffleOptions<T>(options: readonly T[], rng: () => number = Math.random): T[] {
	const out = [...options];
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(rng() * (i + 1));
		[out[i], out[j]] = [out[j], out[i]];
	}
	return out;
}

/**
 * The options and answer of a multiple-choice item in random order. If the model wrote letter labels ("A) …", "B) …") on every
 * option, they are removed first — shuffled labels would read C, A, E, B, D — and from the answer too, so the answer is still
 * exactly one option's text.
 */
export function shuffleQuestionOptions(options: readonly string[], answer: string, rng: () => number = Math.random): { options: string[]; answer: string } {
	const labelled = options.length > 1 && options.every((o) => LETTER_LABEL.test(o));
	if (!labelled) return { options: shuffleOptions(options, rng), answer };
	const strip = (s: string) => s.replace(LETTER_LABEL, '').trim();
	return { options: shuffleOptions(options.map(strip), rng), answer: strip(answer) };
}
