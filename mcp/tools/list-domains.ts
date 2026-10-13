import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { listDomainStats, vaultIsIndexed } from '../../src/lib/server/retrieve';
import { withVault } from '../vault-scope';
import { logCall } from '../log';
import { toolErrorResult, ToolError } from '../errors';

export function registerListDomains(server: McpServer): void {
	server.registerTool(
		'list_domains',
		{
			title: 'List domains',
			description:
				'List the domains present in one vault (the `domain` values of the notes\' frontmatter) with the ' +
				'number of notes in each and when the newest note in the domain was last changed. Use it to see ' +
				'what a vault covers before filtering search_library or list_sources by `domain`. Reads the search ' +
				'index (an unindexed note does not count); a note with several domains counts under each.',
			inputSchema: {
				vault: z.string().optional().describe('Vault id — omit to use the active vault (see list_vaults).')
			},
			annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
		},
		async ({ vault }) => {
			const start = Date.now();
			try {
				const { vaultId, stats } = await withVault(vault, (v) => {
					if (!vaultIsIndexed(v)) {
						throw new ToolError('NOT_INDEXED', `Vault '${v.id}' henüz indekslenmemiş (npm run index -- --vault ${v.id}).`);
					}
					return { vaultId: v.id, stats: listDomainStats(v) };
				});
				logCall({
					ts: new Date().toISOString(),
					tool: 'list_domains',
					vault: vaultId,
					ok: true,
					ms: Date.now() - start,
					resultCount: stats.domains.length,
					params: {}
				});
				return {
					content: [
						{
							type: 'text' as const,
							text: JSON.stringify(
								{ vault: vaultId, totalNotes: stats.totalNotes, noDomain: stats.noDomain, domains: stats.domains },
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
					tool: 'list_domains',
					vault: vault ?? null,
					ok: false,
					ms: Date.now() - start,
					errorCode: result.content[0].text.split(':')[0],
					params: {}
				});
				return result;
			}
		}
	);
}
