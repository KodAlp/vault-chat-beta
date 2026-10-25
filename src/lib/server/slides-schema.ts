import { z } from 'zod';
import type { DiagramSpec } from './slides-diagram';

/**
 * Every layout `buildMarpDeck` (generate-slides.ts) and
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

/**
 * Only meaningful when `layout === 'diagram'`, optional
 * everywhere else (same "superset schema, prompt + soft validation carry
 * the per-layout meaning" pattern the "4-6 madde" bullets rule already
 * uses — see generate-slides.ts). The model supplies structure and labels
 * only; slides-diagram.ts's renderDiagramSvg is the only thing that ever
 * produces markup from it, so there's no schema-level need to sanitize
 * strings here beyond the length/count bounds below.
 */
const DiagramNode = z.object({ id: z.string().min(1).max(40), label: z.string().min(1).max(200) });
const DiagramEdge = z.object({
	from: z.string().min(1).max(40),
	to: z.string().min(1).max(40),
	label: z.string().max(80).optional()
});
export const SlideDiagram = z.object({
	nodes: z.array(DiagramNode).min(1).max(8),
	edges: z.array(DiagramEdge).max(12)
}) satisfies z.ZodType<DiagramSpec>;
export type SlideDiagramT = z.infer<typeof SlideDiagram>;

export const Slide = z.object({
	layout: z.enum(SLIDE_LAYOUTS),
	heading: z.string().min(1),
	content_markdown: z.string().min(1),
	notes: z.string().optional(),
	diagram: SlideDiagram.optional(),
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
						diagram: {
								type: 'object',
								properties: {
									nodes: {
										type: 'array',
										minItems: 1,
										maxItems: 8,
										items: {
											type: 'object',
											properties: { id: { type: 'string' }, label: { type: 'string' } },
											required: ['id', 'label']
										}
									},
									edges: {
										type: 'array',
										maxItems: 12,
										items: {
											type: 'object',
											properties: {
												from: { type: 'string' },
												to: { type: 'string' },
												label: { type: 'string' }
											},
											required: ['from', 'to']
										}
									}
								},
								required: ['nodes', 'edges']
							},
							source_id: { type: 'string', enum: validIds }
					},
					required: ['layout', 'heading', 'content_markdown', 'source_id']
				}
			}
		},
		required: ['slides']
	} as const;
}
