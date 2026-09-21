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

export type QuizItemType = 'multiple_choice' | 'true_false' | 'open';

export interface TypedBatch {
	type: QuizItemType;
	count: number;
}

/**
 * Batches that each hold ONE question type, in mc, tf, open order, at most maxPerBatch per batch and as even as
 * possible within a type (7 with a limit of 5 is 4+3, not 5+2).
 *
 * Why not the mixed batches above: measured on the real vault, a mixed batch's grammar cannot say how many of each
 * type it wants, so the requested 4/2/4 came back 6/2/2 in every one of four quizzes, and the multiple-choice
 * `options` list — optional in a mixed schema — was missing from 46 of 80 real questions (18 of 24 in the experiment),
 * leaving questions nobody could answer. With one type per batch the schema can pin `type`, REQUIRE the five options for
 * multiple choice and restrict a true/false answer to true|false.
 */
export function splitCompositionByType(composition: QuizComposition, maxPerBatch: number): TypedBatch[] {
	const out: TypedBatch[] = [];
	const add = (type: QuizItemType, total: number) => {
		if (total <= 0) return;
		const parts = Math.ceil(total / maxPerBatch);
		const base = Math.floor(total / parts);
		const extra = total % parts;
		for (let i = 0; i < parts; i++) out.push({ type, count: base + (i < extra ? 1 : 0) });
	};
	add('multiple_choice', composition.mc);
	add('true_false', composition.tf);
	add('open', composition.open);
	return out;
}

/**
 * One source part per QUESTION, decided up front: `counts[j]` is how many questions batch j will write; the result's
 * j-th list is the source ids for those questions, in order. Ids are dealt in rank order across the whole quiz, so no
 * source part is used twice while the pool lasts (and when there are more questions than parts the deal wraps around).
 *
 * This replaces asking the model to "spread across the sources" and rejecting batches that did not: the model does not
 * spread (10 questions came from 2-3 of 5-12 available parts), and a hard reject only produced retry loops (a batch
 * failed three times over and the multiple-choice batch was lost). The grammar can pin each position's id
 * (quiz-schema.ts, `prefixItems`), so the spread is guaranteed by construction and costs no retry.
 */
export function assignSlots(poolIds: readonly string[], counts: readonly number[]): string[][] {
	if (poolIds.length === 0) return counts.map(() => []);
	let next = 0;
	return counts.map((count) => Array.from({ length: count }, () => poolIds[next++ % poolIds.length]));
}
