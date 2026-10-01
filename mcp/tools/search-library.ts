import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { retrieve, vaultIsIndexed } from '../../src/lib/server/retrieve';
import { withVault } from '../vault-scope';
import { logCall } from '../log';
import { AppError } from '../../src/lib/server/app-error';
import { toolErrorResult, ToolError } from '../errors';

const SNIPPET_MAX_CHARS = 600;

function snippet(text: string): { snippet: string; truncated: boolean } {
	if (text.length <= SNIPPET_MAX_CHARS) return { snippet: text, truncated: false };
	return { snippet: `${text.slice(0, SNIPPET_MAX_CHARS)}…`, truncated: true };
}

export function registerSearchLibrary(server: McpServer): void {
	server.registerTool(
		'search_library',
		{
			title: 'Search library',
			description:
				'Semantic (vector) search over one vault\'s indexed notes. Not full-text/hybrid search — ' +
				'v1 is vector-only. Returns the vault id you actually searched, so you never have to guess ' +
				'which one answered. Call list_vaults first if you don\'t already know the vault id, or ' +
				'list_sources to see which domain/level values actually exist before filtering by them.',
			inputSchema: {
				vault: z.string().optional().describe('Vault id — omit to use the active vault (see list_vaults).'),
				query: z.string().min(1).describe('Natural-language search query, in the vault\'s own language.'),
				domain: z
					.string()
					.optional()
					.describe('Filter to one domain, e.g. "math". See list_vaults/list_sources for the domains actually present.'),
				level: z
					.string()
					.optional()
					.describe(
						'Filter to one level (case-insensitive). The value set is whatever this vault\'s frontmatter ' +
							'actually uses (often undergrad/grad/phd, but not guaranteed) — see list_vaults/list_sources.'
					),
				k: z.number().int().min(1).max(25).optional().describe('Max results to return, default 8.')
			},
			annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
		},
		async ({ vault, query, domain, level, k }) => {
			const start = Date.now();
			try {
				const { vaultId, result } = await withVault(vault, async (v) => {
					// Ö7: an empty result set from an unindexed vault used to look
					// exactly like "searched, nothing matched" — both are
					// `{"results":[]}, isError:false`. NOT_INDEXED was defined in
					// errors.ts from the start; nothing produced it.
					if (!vaultIsIndexed(v)) {
						throw new ToolError('NOT_INDEXED', `Vault '${v.id}' henüz indekslenmemiş (npm run index -- --vault ${v.id}).`);
					}
					let r;
					try {
						r = await retrieve(v, query, {
							domains: domain ? [domain] : undefined,
							levels: level ? [level] : undefined,
							k
						});
					} catch (err) {
						// Provider-neutral: the embedding provider may be any server (or none — keyword-only mode
						// never throws here), so name the underlying error code instead of guessing a cause.
						const code = err instanceof AppError ? err.code : 'ERROR';
						const message = err instanceof Error ? err.message : String(err);
						throw new ToolError('RETRIEVAL_FAILED', `Arama başarısız (${code}): ${message}`);
					}
					return { vaultId: v.id, result: r };
				});

				const results = result.chunks.map((c) => {
					const { snippet: text, truncated } = snippet(c.display_text);
					return {
						path: c.path,
						title: c.topic,
						heading_path: c.heading_path,
						level: c.depth,
						domains: c.domains,
						score: Number((1 - c.distance).toFixed(4)),
						snippet: text,
						snippetTruncated: truncated
					};
				});

				logCall({
					ts: new Date().toISOString(),
					tool: 'search_library',
					vault: vaultId,
					ok: true,
					ms: Date.now() - start,
					resultCount: results.length,
					params: { queryChars: query.length, domain, level, k }
				});

				return {
					content: [
						{
							type: 'text' as const,
							text: JSON.stringify({ vault: vaultId, query, narrowScope: result.narrowScope, results }, null, 1)
						}
					]
				};
			} catch (err) {
				const result = toolErrorResult(err);
				logCall({
					ts: new Date().toISOString(),
					tool: 'search_library',
					vault: vault ?? null,
					ok: false,
					ms: Date.now() - start,
					errorCode: result.content[0].text.split(':')[0],
					params: { queryChars: query.length, domain, level, k }
				});
				return result;
			}
		}
	);
}
