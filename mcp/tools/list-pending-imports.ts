import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { appRequest } from '../app-client';
import { logCall } from '../log';
import { toolErrorResult } from '../errors';

interface PendingList {
	vault: string;
	autoConfirm?: string;
	imports: { importId: string; status: string }[];
	/** Imports the app auto-confirmed in the last day: status "confirmed", with the library-relative path. */
	confirmed?: { importId: string; status: string; title: string; path: string; confirmedAt: string }[];
}

export function registerListPendingImports(server: McpServer): void {
	server.registerTool(
		'list_pending_imports',
		{
			title: 'List pending imports',
			description:
				'List the imports waiting in one vault\'s pending area, newest first: importId, status ' +
				'(queued, converting, ready, error), source name, proposed title/domain, warnings, and a coded ' +
				'error when conversion failed. Use it to poll an import_source call. "ready" means converted and ' +
				'waiting for the user to confirm it in the Vault Chat app; you cannot confirm or cancel it. The ' +
				'response also carries the vault\'s autoConfirm setting (off | clean | all): when the user enabled ' +
				'it, the app itself confirms finished imports, and those leave this list and appear in "confirmed" ' +
				'(last 24 h) with status "confirmed" and their library path. An item the app tried and failed to ' +
				'auto-confirm stays "ready" with warning IMPORT_AUTO_CONFIRM_FAILED. The Vault Chat app must be ' +
				'running. Includes uploads the user made in the app themselves (by: "app", never auto-confirmed). ' +
				'Call list_vaults first for the vault id.',
			inputSchema: {
				vault: z.string().optional().describe('Vault id — omit to use the active vault (see list_vaults).')
			},
			annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
		},
		async ({ vault }) => {
			const start = Date.now();
			try {
				const query = vault ? `?vault=${encodeURIComponent(vault)}` : '';
				const pending = await appRequest<PendingList>('GET', `/api/mcp/imports${query}`);

				logCall({
					ts: new Date().toISOString(),
					tool: 'list_pending_imports',
					vault: pending.vault,
					ok: true,
					ms: Date.now() - start,
					resultCount: pending.imports.length,
					params: {}
				});

				return {
					content: [
						{
							type: 'text' as const,
							text: JSON.stringify(
								{
									vault: pending.vault,
									autoConfirm: pending.autoConfirm ?? 'off',
									imports: pending.imports,
									confirmed: pending.confirmed ?? [],
									note:
										'Items with status "ready" are waiting for the user to confirm them in the Vault Chat app. ' +
										'Items under "confirmed" were confirmed by the app on the user\'s auto-confirm setting and are already in the library.'
								},
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
					tool: 'list_pending_imports',
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
