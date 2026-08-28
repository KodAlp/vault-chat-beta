import { z } from 'zod';

/**
 * The model produces the TREE, not a flat list of paths.
 *
 * The previous shape was `{ path: string[], source_id }[]`, and the server
 * rebuilt the tree from shared path prefixes. That asked a small local model
 * to hand-encode a tree into a list — and essentially every failure observed
 * in real generations came from that encoding layer, not from the content:
 * the citation id leaking into the label array (`path: ["S4", "..."]`),
 * sibling branches that never shared a prefix, whole maps emitted at a single
 * level. A nested schema makes all three *unrepresentable* rather than
 * something validation has to catch afterwards.
 *
 * Depth is fixed at three levels by writing the shape out three times instead
 * of recursing. Ollama constrains decoding by converting this JSON Schema to a
 * GBNF grammar; a flat, explicit nesting is the form that conversion handles
 * most predictably, and three levels is exactly what a mind map needs (topic ->
 * sub-areas -> the keywords/finer splits under them).
 *
 * Counts are deliberately small. Generation runs on a local qwen3:8b that only
 * fits 27 of 37 layers on this GPU, so every extra node is real wall-clock
 * time and another chance to drift off-schema.
 */

/** Leaf level (depth 3): a keyword or a finer split, e.g. "toplamın türevi". */
export const MindMapLeaf = z.object({
	label: z.string().min(1),
	summary: z.string().min(1),
	source_id: z.string().min(1)
});

/** Depth 2: a sub-topic, optionally split further. */
export const MindMapChild = MindMapLeaf.extend({
	children: z.array(MindMapLeaf).max(3).optional()
});

/** Depth 1: one of the main areas the topic breaks into. */
export const MindMapBranch = MindMapLeaf.extend({
	children: z.array(MindMapChild).max(4).optional()
});

/**
 * The root carries the topic itself and what it MEANS — the user's first
 * requirement, and something the old schema had no place for at all (the map
 * used to render with an empty, unlabelled root circle). It has no source_id:
 * it is the subject of the map, not a claim quoted from one chunk.
 */
export const MindMapTreeSchema = z.object({
	root: z.object({
		label: z.string().min(1),
		summary: z.string().min(1)
	}),
	branches: z.array(MindMapBranch).min(1).max(6)
});
export type MindMapTreeT = z.infer<typeof MindMapTreeSchema>;

/**
 * Built per request rather than kept as a module constant, because
 * `source_id`'s enum is the retrieved chunk ids for THIS generation — with the
 * enum in place an invalid citation is literally undecodable, instead of
 * something the validator has to reject after a full generation was spent on
 * it. Same construction as report-schema.ts's buildReportSectionsJsonSchema.
 *
 * `summary` carries a maxLength as a best-effort brake, and is ALSO trimmed
 * server-side (mindmap-validate.ts) because llama.cpp's GBNF conversion does not
 * enforce string length reliably. It matters more than it looks: an unbounded
 * string is the one place this grammar lets the model emit tokens forever, and
 * a run was observed doing exactly that for 28 minutes. The real guard is the
 * generation budget in generate-mindmap.ts; this just makes it less likely to
 * be needed.
 */
export function buildMindMapTreeJsonSchema(validIds: string[]) {
	const leaf = {
		type: 'object',
		properties: {
			label: { type: 'string', maxLength: 60 },
			summary: { type: 'string', maxLength: 450 },
			source_id: { type: 'string', enum: validIds }
		},
		required: ['label', 'summary', 'source_id']
	} as const;

	return {
		type: 'object',
		properties: {
			root: {
				type: 'object',
				properties: {
					label: { type: 'string', maxLength: 60 },
					summary: { type: 'string', maxLength: 450 }
				},
				required: ['label', 'summary']
			},
			branches: {
				type: 'array',
				minItems: 1,
				maxItems: 6,
				items: {
					...leaf,
					properties: {
						...leaf.properties,
						children: {
							type: 'array',
							maxItems: 4,
							items: {
								...leaf,
								properties: {
									...leaf.properties,
									children: { type: 'array', maxItems: 3, items: leaf }
								}
							}
						}
					}
				}
			}
		},
		required: ['root', 'branches']
	} as const;
}
