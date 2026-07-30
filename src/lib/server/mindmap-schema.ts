import { z } from 'zod';

export const MindMapNode = z.object({
	path: z.array(z.string().min(1)).min(1).max(4),
	source_path: z.string().min(1),
	heading_path: z.string().min(1)
});
export type MindMapNodeT = z.infer<typeof MindMapNode>;

export const MindMapNodes = z.object({ nodes: z.array(MindMapNode).min(1).max(40) });
export type MindMapNodesT = z.infer<typeof MindMapNodes>;

/**
 * Hand-written JSON Schema mirror, for Ollama's `format` param. `path`'s
 * shape (array of strings, 1-4 items) is a minor variant of quiz-schema.ts's
 * already-proven `options: string[]` field — not a novel shape for this
 * install's structured-output support.
 */
export const MINDMAP_NODES_JSON_SCHEMA = {
	type: 'object',
	properties: {
		nodes: {
			type: 'array',
			minItems: 1,
			maxItems: 40,
			items: {
				type: 'object',
				properties: {
					path: {
						type: 'array',
						items: { type: 'string' },
						minItems: 1,
						maxItems: 4
					},
					source_path: { type: 'string' },
					heading_path: { type: 'string' }
				},
				required: ['path', 'source_path', 'heading_path']
			}
		}
	},
	required: ['nodes']
} as const;
