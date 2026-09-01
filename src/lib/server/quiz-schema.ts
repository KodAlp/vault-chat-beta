import { z } from 'zod';

/**
 * source_id, not source_path: the model cites a short handle (`S1`, `S2`,
 * ...) assigned per-chunk in generate-quiz.ts's context block, not the full
 * vault path (which runs 40-80+ chars, e.g.
 * `wiki/math/sources/<kitap>/<konu>.md`). Same fix as report-schema.ts and
 * cards-schema.ts, for the identical failure mode: a model asked to copy a
 * long path verbatim across up to 20 questions reliably drops/mangles
 * characters under partial-GPU-offload latency.
 *
 * heading_path is no longer asked for either — the server resolves it from
 * the cited id, the same simplification mindmap-schema.ts made.
 */
export const QuizItem = z.object({
	type: z.enum(['multiple_choice', 'true_false', 'open']),
	question: z.string().min(1),
	options: z.array(z.string()).length(5).optional(),
	answer: z.string().min(1),
	explanation: z.string().min(1),
	source_id: z.string().min(1)
});
export type QuizItemT = z.infer<typeof QuizItem>;

export const QuizItems = z.object({ items: z.array(QuizItem) });
export type QuizItemsT = z.infer<typeof QuizItems>;

/**
 * A FUNCTION, not a static const, because `source_id` is constrained by
 * `enum: validIds` rather than a free string — Ollama/llama.cpp's
 * JSON-schema-to-GBNF grammar compiler doesn't reliably translate regex
 * patterns (see report-schema.ts's doc comment for the exact failure this
 * caused live), so an enum of the ids actually offered this request is used
 * instead. As a bonus this is STRICTER than a regex ever was: the model is
 * sampling-time restricted to ids that actually exist in this request's
 * context block, not just to the right shape.
 */
export function buildQuizItemsJsonSchema(validIds: string[]) {
	return {
		type: 'object',
		properties: {
			items: {
				type: 'array',
				items: {
					type: 'object',
					properties: {
						type: { type: 'string', enum: ['multiple_choice', 'true_false', 'open'] },
						question: { type: 'string' },
						options: { type: 'array', items: { type: 'string' }, minItems: 5, maxItems: 5 },
						answer: { type: 'string' },
						explanation: { type: 'string' },
						source_id: { type: 'string', enum: validIds }
					},
					required: ['type', 'question', 'answer', 'explanation', 'source_id']
				}
			}
		},
		required: ['items']
	} as const;
}
