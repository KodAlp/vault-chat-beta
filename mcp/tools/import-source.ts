import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { appRequest } from '../app-client';
import { logCall } from '../log';
import { toolErrorResult, ToolError } from '../errors';

interface QueuedImport {
	vault: string;
	importId: string;
	status: string;
	/** The user's per-vault setting for what the app does with a finished import: off | clean | all. */
	autoConfirm?: string;
}

/** Plain-English consequence of the vault's setting, so the agent does not promise the user something untrue. */
function nextStep(autoConfirm: string | undefined): string {
	const poll = 'Poll list_pending_imports until this importId is "ready" (or listed under "confirmed").';
	if (autoConfirm === 'all') {
		return `${poll} This vault auto-confirms every import that converts successfully: it then enters the library without the user reviewing it, and shows up under "confirmed" with its library path. You cannot confirm or cancel it yourself.`;
	}
	if (autoConfirm === 'clean') {
		return `${poll} This vault auto-confirms only clean imports (no warnings, no needs-review, not a duplicate): those enter the library by themselves and show up under "confirmed"; anything else waits for the user to confirm it in the Vault Chat app. You cannot confirm it yourself.`;
	}
	return `${poll} It then waits for the user to confirm it in the Vault Chat app; you cannot confirm it.`;
}

export function registerImportSource(server: McpServer): void {
	server.registerTool(
		'import_source',
		{
			title: 'Import source',
			description:
				'Stage ONE source (a local file path OR a URL, exactly one) for import into a vault. The Vault Chat ' +
				'app must be running. This call never puts anything in the library itself: the source is converted ' +
				'in the background into a PENDING list, and it enters the library only when the USER confirms it in ' +
				'the Vault Chat app — or when the app confirms it for you because the user turned on auto-confirm ' +
				'for this vault (the response says which: autoConfirm = off | clean | all). You can never confirm ' +
				'or change that setting. Returns an importId immediately with status "queued"; poll ' +
				'list_pending_imports for queued -> converting -> ready (or error, or confirmed). Local paths ' +
				'must be absolute paths to regular files (no symlinks) under a folder the user allowed in the ' +
				'app\'s Settings, otherwise MCP_IMPORT_ROOTS_EMPTY / MCP_PATH_NOT_ALLOWED comes back; URLs go ' +
				'through the app\'s normal web import (public http/https hosts only, robots.txt respected; PDFs, ' +
				'web pages and YouTube links). Call list_vaults first for the vault id (the vault must be open to ' +
				'MCP), or create_vault for a new one. Every response echoes the resolved vault id.',
			inputSchema: {
				vault: z.string().optional().describe('Vault id — omit to use the active vault (see list_vaults).'),
				path: z.string().optional().describe('Absolute path of a local file under a folder the user allowed. Give this OR url.'),
				url: z.string().optional().describe('http(s) URL of a PDF, web page or YouTube video. Give this OR path.'),
				domain: z
					.string()
					.optional()
					.describe('Library folder (subject area) the note should go to, default "genel". The user can still change it when confirming.'),
				title: z.string().optional().describe('Proposed note title; defaults to the document\'s own title or file name.')
			},
			annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true }
		},
		async ({ vault, path: filePath, url, domain, title }) => {
			const start = Date.now();
			// kind/domain only: the path or URL text itself is never logged (it can name private files or carry secrets).
			const kind = filePath ? 'path' : 'url';
			const params = { kind, domain };
			try {
				if (Boolean(filePath) === Boolean(url)) {
					throw new ToolError('INVALID_ARGUMENTS', 'Give exactly one of `path` or `url`.');
				}
				const queued = await appRequest<QueuedImport>('POST', '/api/mcp/imports', { vault, path: filePath, url, domain, title });

				logCall({
					ts: new Date().toISOString(),
					tool: 'import_source',
					vault: queued.vault,
					ok: true,
					ms: Date.now() - start,
					params
				});

				return {
					content: [
						{
							type: 'text' as const,
							text: JSON.stringify(
								{
									vault: queued.vault,
									importId: queued.importId,
									status: queued.status,
									autoConfirm: queued.autoConfirm ?? 'off',
									next: nextStep(queued.autoConfirm)
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
					tool: 'import_source',
					vault: vault ?? null,
					ok: false,
					ms: Date.now() - start,
					errorCode: result.content[0].text.split(':')[0],
					params
				});
				return result;
			}
		}
	);
}
