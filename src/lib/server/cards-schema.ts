import { z } from 'zod';

/**
 * source_id, not source_path: the model cites a short handle (`S1`, `S2`,
 * ...) assigned per-chunk in generate-cards.ts's context block, not the full
 * vault path (which runs 40-80+ chars, e.g.
 * `wiki/math/sources/<kitap>/<konu>.md`). A model asked to copy that verbatim
 * across up to 30 cards reliably drops/mangles characters under
 * partial-GPU-offload latency — the exact failure mode that made report
 * generation have a 0% success rate before the same fix (see
 * report-schema.ts's doc comment), and confirmed live for cards too (a real
 * generation request failed with every retry exhausted, all on "uydurma
 * kaynak" — the model's path just didn't match anything retrieval returned).
 *
 * heading_path is no longer asked for either, for the same reason
 * mindmap-schema.ts dropped it: it always described a chunk the server
 * already had in hand, so the server resolves it from the cited id instead
 * of trusting a second transcription.
 *
 * generate-cards.ts's parseAndValidate() translates ids back to real
 * source_path/heading_path before anything reaches study-db.ts, so
 * NewCard (study-db.ts) and everything downstream never learn this scheme
 * exists.
 */
export const Card = z.object({
	front: z.string().min(1),
	back: z.string().min(1),
	source_id: z.string().min(1)
});
export type CardT = z.infer<typeof Card>;

export const Cards = z.object({ items: z.array(Card) });
export type CardsT = z.infer<typeof Cards>;

/**
 * A FUNCTION, not a static const, because `source_id` is constrained by
 * `enum: validIds` rather than a regex `pattern` — Ollama/llama.cpp's
 * JSON-schema-to-GBNF grammar compiler doesn't reliably translate regex
 * patterns (see report-schema.ts's doc comment for the exact failure this
 * caused live). `enum` compiles to GBNF as a plain set of string
 * alternatives, and as a bonus is STRICTER than the regex ever was: the
 * model is sampling-time restricted to ids that actually exist in this
 * request's context block, not just to the right shape.
 *
 * `domain`/`level` stay deliberately NOT model-supplied fields (see
 * generate-cards.ts) — they're derived server-side from the retrieved
 * chunk's own metadata once source_id resolves, same as heading_path.
 */
export function buildCardsJsonSchema(validIds: string[]) {
	return {
		type: 'object',
		properties: {
			items: {
				type: 'array',
				items: {
					type: 'object',
					properties: {
						front: { type: 'string' },
						back: { type: 'string' },
						source_id: { type: 'string', enum: validIds }
					},
					required: ['front', 'back', 'source_id']
				}
			}
		},
		required: ['items']
	} as const;
}
