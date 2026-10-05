import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { appRequest } from '../app-client';
import { logCall } from '../log';
import { toolErrorResult } from '../errors';

interface CreatedVault {
	id: string;
	name: string;
}

export function registerCreateVault(server: McpServer): void {
	server.registerTool(
		'create_vault',
		{
			title: 'Create vault',
			description:
				'Create a new, empty vault (knowledge base) in the Vault Chat app and open it to MCP so the other ' +
				'tools can use it right away. The Vault Chat app must be running — this goes through the app, not ' +
				'the files. The vault is marked "created via MCP" in the app. Returns the vault id: pass it as ' +
				'`vault` to import_source and the read tools. Call list_vaults first and reuse an existing vault ' +
				'when one fits, rather than creating near-duplicates.',
			inputSchema: {
				name: z.string().min(1).max(100).describe('Display name for the new vault; the id is derived from it.')
			},
			annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
		},
		async ({ name }) => {
			const start = Date.now();
			try {
				const created = await appRequest<CreatedVault>('POST', '/api/mcp/vaults', { name });

				logCall({
					ts: new Date().toISOString(),
					tool: 'create_vault',
					vault: created.id,
					ok: true,
					ms: Date.now() - start,
					// The vault name is user content; only its length is logged.
					params: { nameChars: name.length }
				});

				return {
					content: [
						{
							type: 'text' as const,
							text: JSON.stringify(
								{
									vault: created.id,
									name: created.name,
									note: 'Vault created and open to MCP. It is empty: use import_source to stage sources; the user confirms them in the Vault Chat app.'
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
					tool: 'create_vault',
					vault: null,
					ok: false,
					ms: Date.now() - start,
					errorCode: result.content[0].text.split(':')[0],
					params: { nameChars: name.length }
				});
				return result;
			}
		}
	);
}
