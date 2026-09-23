import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { listVaults, getActiveVaultId, contextFor } from '../../src/lib/server/vaults';
import { closeVaultIndexDb, countUnindexedFiles, listDomains, listLevels, listSources } from '../../src/lib/server/retrieve';
import { logCall } from '../log';
import { runSerialized } from '../vault-scope';
import { toolErrorResult } from '../errors';

export function registerListVaults(server: McpServer): void {
	server.registerTool(
		'list_vaults',
		{
			title: 'List vaults',
			description:
				'List every vault in this vault-chat instance, with indexing status, note count, ' +
				'and the domains/levels actually present. unindexedCount > 0 means files exist on disk ' +
				'that `npm run index` has not been run against since — search_library/list_sources will ' +
				'not see them yet. Call this first — every other tool takes an optional vault id, and ' +
				'this is how you find one (or confirm the active vault is the right one to search).',
			inputSchema: {},
			annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
		},
		async () => {
			const start = Date.now();
			try {
				const vaults = await runSerialized(() => {
					const activeId = getActiveVaultId();
					return listVaults().map((record) => {
						const v = contextFor(record);
						try {
							const { total } = listSources(v, { limit: 0 });
							return {
								id: v.id,
								name: v.name,
								active: v.id === activeId,
								indexed: total > 0 || listDomains(v).length > 0,
								noteCount: total,
								// Files on disk index-vault.ts would walk but hasn't yet —
								// a curation pass that finished without a `npm run index`
								// afterward (E2). 0 for a vault with nothing pending.
								unindexedCount: countUnindexedFiles(v),
								domains: listDomains(v),
								levels: listLevels(v),
								lastOpenedAt: record.lastOpenedAt
							};
						} finally {
							closeVaultIndexDb(v.id);
						}
					});
				});

				logCall({
					ts: new Date().toISOString(),
					tool: 'list_vaults',
					vault: null,
					ok: true,
					ms: Date.now() - start,
					resultCount: vaults.length,
					params: {}
				});

				return { content: [{ type: 'text' as const, text: JSON.stringify({ vaults }, null, 1) }] };
			} catch (err) {
				const result = toolErrorResult(err);
				logCall({
					ts: new Date().toISOString(),
					tool: 'list_vaults',
					vault: null,
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
