import { z } from 'zod';

/**
 * source_id, not source_path: the model cites a short handle (`S1`, `S2`,
 * ...) assigned per-chunk in generate-slides.ts's context block, not the
 * full vault path. Same fix as report/cards/quiz-schema.ts, for the
 * identical failure mode — a model asked to copy a long path verbatim
 * reliably drops/mangles characters under partial-GPU-offload latency.
 */
export const Slide = z.object({
	content_markdown: z.string().min(1),
	source_id: z.string().min(1)
});
export type SlideT = z.infer<typeof Slide>;

export const Slides = z.object({ slides: z.array(Slide).min(3).max(20) });
export type SlidesT = z.infer<typeof Slides>;

/**
 * A FUNCTION, not a static const, because `source_id` is constrained by
 * `enum: validIds` — see quiz-schema.ts's doc comment for why an enum beats
 * a regex pattern for Ollama's GBNF grammar compiler.
 */
export function buildSlidesJsonSchema(validIds: string[]) {
	return {
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
						source_id: { type: 'string', enum: validIds }
					},
					required: ['content_markdown', 'source_id']
				}
			}
		},
		required: ['slides']
	} as const;
}
