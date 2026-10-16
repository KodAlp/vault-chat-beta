import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { listSources, vaultIsIndexed } from '../../src/lib/server/retrieve';
import { withVault } from '../vault-scope';
import { logCall } from '../log';
import { toolErrorResult, ToolError } from '../errors';

const DEFAULT_LIMIT = 200;

export function registerListSources(server: McpServer): void {
	server.registerTool(
		'list_sources',
		{
			title: 'List sources',
			description:
				'List indexed notes in one vault (path, title, level, domains, chunk count), paginated. Reads ' +
				'the search index, not the filesystem — a file that exists on disk but was never indexed will ' +
				'not appear here (see list_vaults\'s "indexed" flag, or re-run indexing).',
			inputSchema: {
				vault: z.string().optional().describe('Vault id — omit to use the active vault (see list_vaults).'),
				domain: z.string().optional().describe('Filter to one domain.'),
				level: z.string().optional().describe('Filter to one level (case-insensitive) — see list_vaults for the values a vault actually uses.'),
				limit: z.number().int().min(0).max(500).optional().describe(`Max rows to return, default ${DEFAULT_LIMIT}.`),
				offset: z.number().int().min(0).optional().describe('Rows to skip, for paging past the limit.')
			},
			annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
		},
		async ({ vault, domain, level, limit, offset }) => {
			const start = Date.now();
			try {
				const { vaultId, total, sources } = await withVault(vault, (v) => {
					// Ö7: same NOT_INDEXED gap as search_library — an unindexed
					// vault returned `{"total":0,"sources":[]}, isError:false`,
					// indistinguishable from "indexed, filter matched nothing".
					if (!vaultIsIndexed(v)) {
						throw new ToolError('NOT_INDEXED', `Vault '${v.id}' henüz indekslenmemiş: uygulamada Ayarlar → Kasalar → Yeniden indeksle.`);
					}
					const r = listSources(v, {
						domains: domain ? [domain] : undefined,
						levels: level ? [level] : undefined,
						limit: limit ?? DEFAULT_LIMIT,
						offset
					});
					return { vaultId: v.id, ...r };
				});

				logCall({
					ts: new Date().toISOString(),
					tool: 'list_sources',
					vault: vaultId,
					ok: true,
					ms: Date.now() - start,
					resultCount: sources.length,
					params: { domain, level, limit, offset }
				});

				return {
					content: [
						{
							type: 'text' as const,
							text: JSON.stringify(
								{ vault: vaultId, total, offset: offset ?? 0, limit: limit ?? DEFAULT_LIMIT, sources },
								null,
								1
							)
						}
					]
				};
			} catch (err) {
				const result = toolErrorResult(err);
				logCall({
					ts: new Date().toISOString(),
					tool: 'list_sources',
					vault: vault ?? null,
					ok: false,
					ms: Date.now() - start,
					errorCode: result.content[0].text.split(':')[0],
					params: { domain, level, limit, offset }
				});
				return result;
			}
		}
	);
}
