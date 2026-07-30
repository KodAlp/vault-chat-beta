import { z } from 'zod';

export const ReportSection = z.object({
	heading: z.string().min(1),
	body_markdown: z.string().min(1),
	source_paths: z.array(z.string().min(1)).min(1).max(4)
});
export type ReportSectionT = z.infer<typeof ReportSection>;

export const ReportSections = z.object({ sections: z.array(ReportSection).min(1).max(8) });
export type ReportSectionsT = z.infer<typeof ReportSections>;

/**
 * Hand-written JSON Schema mirror of ReportSections, for Ollama's `format`
 * param — same rationale as QUIZ_ITEMS_JSON_SCHEMA (quiz-schema.ts): not
 * auto-derived from zod, kept in this one file so the two can't drift.
 */
export const REPORT_SECTIONS_JSON_SCHEMA = {
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
					source_paths: {
						type: 'array',
						items: { type: 'string' },
						minItems: 1,
						maxItems: 4
					}
				},
				required: ['heading', 'body_markdown', 'source_paths']
			}
		}
	},
	required: ['sections']
} as const;
