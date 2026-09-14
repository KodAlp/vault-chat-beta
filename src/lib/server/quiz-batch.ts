/**
 * Pure batching logic for quiz generation, split out of generate-quiz.ts for
 * the same reason cards-validate.ts/mindmap-validate.ts were split out of
 * their generators: generate-quiz.ts pulls in providers/registry ->
 * $env/dynamic/private, which only resolves inside a SvelteKit/Vite run, so
 * nothing in it can be exercised under plain `tsx --test`. This is what
 * quiz-batch.test.ts actually runs.
 */

export interface QuizComposition {
	mc: number;
	tf: number;
	open: number;
}

/**
 * Splits a full composition into a sequence of sub-compositions, each
 * summing to at most maxPerBatch, filled mc-first then tf then open — see
 * generate-quiz.ts's QUIZ_ITEMS_PER_BATCH doc comment for why batching
 * exists at all (the quality-collapse fix). generate-quiz.ts's
 * buildSystemPrompt/buildQuizItemsJsonSchema already handle any mix per
 * call, so mc-first fill order is just the simplest greedy split, not a
 * requirement — callers must not rely on which type lands in which batch.
 *
 * A composition that is already all-zero returns an empty array (no
 * batches to run), not a single empty batch — generateQuiz itself already
 * rejects an all-zero request before reaching batching, but this function
 * stays correct on its own terms either way.
 */
export function splitComposition(composition: QuizComposition, maxPerBatch: number): QuizComposition[] {
	const batches: QuizComposition[] = [];
	let { mc, tf, open } = composition;
	while (mc + tf + open > 0) {
		const takeMc = Math.min(mc, maxPerBatch);
		let rest = maxPerBatch - takeMc;
		const takeTf = Math.min(tf, rest);
		rest -= takeTf;
		const takeOpen = Math.min(open, rest);
		batches.push({ mc: takeMc, tf: takeTf, open: takeOpen });
		mc -= takeMc;
		tf -= takeTf;
		open -= takeOpen;
	}
	return batches;
}
