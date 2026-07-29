import { z } from 'zod';

export const Card = z.object({
	front: z.string().min(1),
	back: z.string().min(1),
	source_path: z.string().min(1),
	heading_path: z.string().min(1)
});
export type CardT = z.infer<typeof Card>;

export const Cards = z.object({ items: z.array(Card) });
export type CardsT = z.infer<typeof Cards>;

/**
 * Hand-written JSON Schema mirror of Cards, for Ollama's `format` param —
 * same reasoning as quiz-schema.ts: two schemas this small aren't worth a
 * zod-to-JSON-Schema conversion dependency. `domain`/`level` are deliberately
 * NOT model-supplied fields (see generate-cards.ts) — they're derived
 * server-side from the retrieved chunk's own metadata once source_path
 * passes the anti-hallucination check, same as heading_path already is.
 */
export const CARDS_JSON_SCHEMA = {
	type: 'object',
	properties: {
		items: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					front: { type: 'string' },
					back: { type: 'string' },
					source_path: { type: 'string' },
					heading_path: { type: 'string' }
				},
				required: ['front', 'back', 'source_path', 'heading_path']
			}
		}
	},
	required: ['items']
} as const;
