import { z } from 'zod';
import { COGNITIVE_LEVELS, type CognitiveLevel } from '../cognitive-levels';

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
	/** Optional here on purpose: the JSON schema requires it whenever levels are asked for (Ollama enforces that as a grammar), but a
	 * provider that ignores the schema should still produce a usable, merely unlabelled quiz. */
	cognitive_level: z.enum(COGNITIVE_LEVELS).optional(),
	question: z.string().min(1),
	options: z.array(z.string()).length(5).optional(),
	answer: z.string().min(1),
	explanation: z.string().min(1),
	source_id: z.string().min(1)
});
export type QuizItemT = z.infer<typeof QuizItem>;

export const QuizItems = z.object({ items: z.array(QuizItem) });
export type QuizItemsT = z.infer<typeof QuizItems>;

export type QuizItemKind = 'multiple_choice' | 'true_false' | 'open';

/**
 * A FUNCTION, not a static const, because `source_id` is constrained by
 * `enum: validIds` rather than a free string — Ollama/llama.cpp's
 * JSON-schema-to-GBNF grammar compiler doesn't reliably translate regex
 * patterns (see report-schema.ts's doc comment for the exact failure this
 * caused live), so an enum of the ids actually offered this request is used
 * instead. As a bonus this is STRICTER than a regex ever was: the model is
 * sampling-time restricted to ids that actually exist in this request's
 * context block, not just to the right shape.
 *
 * `kind` narrows the schema to ONE question type (generate-quiz.ts batches by type). That is what makes the rest
 * enforceable by the grammar instead of hoped for: `type` is pinned, multiple choice REQUIRES its five `options`
 * (in the mixed schema `options` was optional, and 46 of 80 real multiple-choice questions had none), a true/false
 * answer can only be `true` or `false`, and a true/false or open question carries no options at all.
 * Without `kind` the schema is the old mixed one.
 */
export function buildQuizItemsJsonSchema(validIds: string[], total: number, kind?: QuizItemKind, slots?: readonly string[], levels?: readonly CognitiveLevel[]) {
	const properties: Record<string, unknown> = {
		type: { type: 'string', enum: kind ? [kind] : ['multiple_choice', 'true_false', 'open'] },
		...(levels ? { cognitive_level: { type: 'string', enum: [...COGNITIVE_LEVELS] } } : {}),
		question: { type: 'string' }
	};
	if (!kind || kind === 'multiple_choice') properties.options = { type: 'array', items: { type: 'string' }, minItems: 5, maxItems: 5 };
	properties.answer = kind === 'true_false' ? { type: 'string', enum: ['true', 'false'] } : { type: 'string' };
	properties.explanation = { type: 'string' };
	const required = ['type', ...(levels ? ['cognitive_level'] : []), 'question', ...(kind === 'multiple_choice' ? ['options'] : []), 'answer', 'explanation', 'source_id'];
	const itemFor = (ids: string[], level?: CognitiveLevel) => ({
		type: 'object',
		properties: { ...properties, ...(level ? { cognitive_level: { type: 'string', enum: [level] } } : {}), source_id: { type: 'string', enum: ids } },
		required
	});
	// With slots, position i can only cite slots[i] (prefixItems): every question is tied to its own source part by the grammar.
	const items = slots && slots.length === total ? { type: 'array', minItems: total, maxItems: total, prefixItems: slots.map((id, i) => itemFor([id], levels?.[i])) } : { type: 'array', minItems: total, maxItems: total, items: itemFor(validIds) };
	return { type: 'object', properties: { items }, required: ['items'] } as const;
}
