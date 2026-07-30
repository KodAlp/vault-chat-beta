import { z } from 'zod';

export const Slide = z.object({
	content_markdown: z.string().min(1),
	source_path: z.string().min(1)
});
export type SlideT = z.infer<typeof Slide>;

export const Slides = z.object({ slides: z.array(Slide).min(3).max(20) });
export type SlidesT = z.infer<typeof Slides>;

/** Simplest of the three new schemas — flat array of two flat string
 * fields, same rationale as quiz/cards' hand-written mirror. */
export const SLIDES_JSON_SCHEMA = {
	type: 'object',
	properties: {
		slides: {
			type: 'array',
			minItems: 3,
			maxItems: 20,
			items: {
				type: 'object',
				properties: {
					content_markdown: { type: 'string' },
					source_path: { type: 'string' }
				},
				required: ['content_markdown', 'source_path']
			}
		}
	},
	required: ['slides']
} as const;
