import { z } from 'zod';

/**
 * F13-1 (Aşama 9) — every layout `buildMarpDeck` (generate-slides.ts) and
 * `slides-theme.ts` know how to render. Adding a value here without a
 * matching `.{layout}` selector in slides-theme.ts silently falls back to
 * that layout looking identical to plain `bullets` — see
 * slides-theme.test.ts's cross-check.
 */
export const SLIDE_LAYOUTS = ['title', 'bullets', 'two-column', 'quote', 'diagram', 'code'] as const;
export type SlideLayout = (typeof SLIDE_LAYOUTS)[number];

/**
 * source_id, not source_path: the model cites a short handle (`S1`, `S2`,
 * ...) assigned per-chunk in generate-slides.ts's context block, not the
 * full vault path. Same fix as report/cards/quiz-schema.ts, for the
 * identical failure mode — a model asked to copy a long path verbatim
 * reliably drops/mangles characters under partial-GPU-offload latency.
 *
 * `heading` used to be the model's own responsibility, folded into the
 * first line of `content_markdown` (a bare `# ...`) — split out so
 * `buildMarpDeck` can place it consistently across every layout instead of
 * re-parsing it back out of free text. `notes` is optional: a provider
 * that ignores the schema (or a model that just has nothing to add) still
 * produces a usable deck without it, same reasoning as quiz-schema.ts's
 * `cognitive_level`.
 */
export const Slide = z.object({
	layout: z.enum(SLIDE_LAYOUTS),
	heading: z.string().min(1),
	content_markdown: z.string().min(1),
	notes: z.string().optional(),
	source_id: z.string().min(1)
});
export type SlideT = z.infer<typeof Slide>;

export const Slides = z.object({ slides: z.array(Slide).min(3).max(20) });
export type SlidesT = z.infer<typeof Slides>;

/**
 * A FUNCTION, not a static const, because `source_id` is constrained by
 * `enum: validIds` — see quiz-schema.ts's doc comment for why an enum beats
 * a regex pattern for Ollama's GBNF grammar compiler. `layout` is an enum
 * for the same GBNF reason, not because it needs per-request values.
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
						layout: { type: 'string', enum: [...SLIDE_LAYOUTS] },
						heading: { type: 'string' },
						content_markdown: { type: 'string' },
						notes: { type: 'string' },
						source_id: { type: 'string', enum: validIds }
					},
					required: ['layout', 'heading', 'content_markdown', 'source_id']
				}
			}
		},
		required: ['slides']
	} as const;
}
