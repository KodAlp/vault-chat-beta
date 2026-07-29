import { z } from 'zod';

export const QuizItem = z.object({
	type: z.enum(['multiple_choice', 'true_false', 'open']),
	question: z.string().min(1),
	options: z.array(z.string()).length(5).optional(),
	answer: z.string().min(1),
	explanation: z.string().min(1),
	source_path: z.string().min(1),
	heading_path: z.string().min(1)
});
export type QuizItemT = z.infer<typeof QuizItem>;

export const QuizItems = z.object({ items: z.array(QuizItem) });
export type QuizItemsT = z.infer<typeof QuizItems>;

/**
 * Hand-written JSON Schema mirror of QuizItems, for Ollama's `format` param
 * (structured output — verified this Ollama install enforces it correctly).
 * Kept separate from the zod schema on purpose: zod validates what comes
 * back in code, this just constrains what the model is allowed to emit —
 * no zod-to-JSON-Schema conversion dependency needed for two schemas this
 * small and this unlikely to drift (both live in this one file).
 */
export const QUIZ_ITEMS_JSON_SCHEMA = {
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
					source_path: { type: 'string' },
					heading_path: { type: 'string' }
				},
				required: ['type', 'question', 'answer', 'explanation', 'source_path', 'heading_path']
			}
		}
	},
	required: ['items']
} as const;
