import { z } from 'zod';

/**
 * source_ids, not source_paths: the model cites short handles (`S1`, `S2`,
 * ...) assigned per-chunk in generate-report.ts's context block, not full
 * vault paths (which run 40-80+ chars, e.g.
 * `wiki/math/sources/<kitap>/<konu>.md`). A model asked to copy those
 * verbatim across up to 8 sections × 4 citations reliably drops/mangles
 * characters under partial-GPU-offload latency, which is why report
 * generation had a 0% success rate before this fix (0 rows in study.db's
 * reports table despite 14 quizzes / 3 mindmaps / 2 slidedecks). See the
 * study-artifacts skill for the shared anti-hallucination contract across
 * all 5 generators. generate-report.ts's parseAndValidate() translates
 * ids back to real paths before anything reaches study-db.ts, so
 * NewReportSection.source_paths (study-db.ts) and everything downstream
 * (ReportView, the view route) never learn this scheme exists.
 */
export const ReportSection = z.object({
	heading: z.string().min(1),
	body_markdown: z.string().min(1),
	source_ids: z.array(z.string().regex(/^S\d+$/)).min(1).max(4)
});
export type ReportSectionT = z.infer<typeof ReportSection>;

export const ReportSections = z.object({ sections: z.array(ReportSection).min(1).max(8) });
export type ReportSectionsT = z.infer<typeof ReportSections>;

/**
 * Hand-written JSON Schema mirror of ReportSections, for Ollama's `format`
 * param — same rationale as QUIZ_ITEMS_JSON_SCHEMA (quiz-schema.ts): not
 * auto-derived from zod, kept in this one file so the two can't drift.
 *
 * A FUNCTION, not a static const, because `source_ids` is constrained by
 * `enum: validIds` rather than a regex `pattern`. This was discovered live
 * (not a preemptive choice): a `pattern: '^S\\d+$'` version shipped first
 * and immediately broke every report request — Ollama/llama.cpp's
 * JSON-schema-to-GBNF grammar compiler doesn't reliably translate regex
 * patterns (the server log showed it emit literally malformed grammar,
 * `"S\d"+`, then fail with "Failed to initialize samplers: failed to parse
 * grammar" before a single token was generated). `enum` compiles to GBNF
 * as a plain set of string alternatives — a well-supported case — and as a
 * bonus is a STRICTER constraint than the regex ever was: the model is now
 * sampling-time restricted to ids that actually exist in this request's
 * context block, not just to the right shape.
 */
export function buildReportSectionsJsonSchema(validIds: string[]) {
	return {
		type: 'object',
		properties: {
			sections: {
				type: 'array',
				minItems: 1,
				maxItems: 8,
				items: {
					type: 'object',
					properties: {
						heading: { type: 'string' },
						body_markdown: { type: 'string' },
						source_ids: {
							type: 'array',
							items: { type: 'string', enum: validIds },
							minItems: 1,
							maxItems: 4
						}
					},
					required: ['heading', 'body_markdown', 'source_ids']
				}
			}
		},
		required: ['sections']
	} as const;
}
