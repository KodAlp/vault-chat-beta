import { z } from 'zod';

/**
 * The model cites a short id (S1, S2, ...), never a path or a heading —
 * exactly the change report-schema.ts made for the same reason: copying a
 * long `wiki/<domain>/sources/<book>/<topic>.md` verbatim is the single
 * biggest source of "uydurma kaynak" retries on a local model, and it
 * cannot get an id wrong when the JSON Schema pins the allowed values.
 *
 * heading_path is deliberately NOT asked for any more. It used to be a
 * second string the model had to transcribe correctly, and it always
 * described a chunk the server already had in hand — so the server now
 * resolves it from the cited id instead. One less thing to get wrong, and
 * the stored value is real data rather than a transcription of it.
 */
export const MindMapNode = z.object({
	path: z.array(z.string().min(1)).min(1).max(4),
	source_id: z.string().min(1)
});
export type MindMapNodeT = z.infer<typeof MindMapNode>;

export const MindMapNodes = z.object({ nodes: z.array(MindMapNode).min(1).max(40) });
export type MindMapNodesT = z.infer<typeof MindMapNodes>;

/**
 * Built per request rather than a module constant, because `source_id`'s
 * enum is the retrieved chunk ids for THIS generation — Ollama constrains
 * decoding to the schema, so an invalid citation becomes literally
 * unrepresentable instead of something parseAndValidate has to catch after
 * the fact. Same construction as report-schema.ts's
 * buildReportSectionsJsonSchema.
 */
export function buildMindMapNodesJsonSchema(validIds: string[]) {
	return {
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
						source_id: { type: 'string', enum: validIds }
					},
					required: ['path', 'source_id']
				}
			}
		},
		required: ['nodes']
	} as const;
}
