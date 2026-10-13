import crypto from 'node:crypto';
import { z } from 'zod';
import matter from 'gray-matter';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { readLibraryFile } from '../../src/lib/server/library-read';
import { withVault } from '../vault-scope';
import { logCall } from '../log';
import { toolErrorResult, ToolError } from '../errors';

const CONTENT_MAX_CHARS = 200_000;

export function registerGetNote(server: McpServer): void {
	server.registerTool(
		'get_note',
		{
			title: 'Get note',
			description:
				'Read one note by its library-relative path (as returned by search_library or list_sources), ' +
				'with frontmatter parsed out separately from the body, plus the content `hash` of the file (pass it as `expected_hash` to edit_note). Rejects any path that resolves outside ' +
				'the vault\'s library root.',
			inputSchema: {
				vault: z.string().optional().describe('Vault id — omit to use the active vault (see list_vaults).'),
				path: z.string().min(1).describe('Library-relative path, e.g. "math/calculus.md".')
			},
			annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
		},
		async ({ vault, path: relPath }) => {
			const start = Date.now();
			try {
				const { vaultId, frontmatter, content, hash } = await withVault(vault, (v) => {
					let raw: string;
					try {
						raw = readLibraryFile(v, relPath);
					} catch (err) {
						const message = err instanceof Error ? err.message : String(err);
						if ((err as { code?: unknown }).code === 'PATH_OUTSIDE_LIBRARY') {
							throw new ToolError('PATH_OUTSIDE_LIBRARY', message);
						}
						if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
							throw new ToolError(
								'NOTE_NOT_FOUND',
								`"${relPath}" indekste görünüyor olabilir ama diskte yok — indeks bayat olabilir ("npm run index" ile yeniden indeksle).`
							);
						}
						throw err;
					}
					const parsed = matter(raw);
					// sha256 of the whole file text (frontmatter included): the `expected_hash` edit_note wants.
					return { vaultId: v.id, frontmatter: parsed.data, content: parsed.content, hash: crypto.createHash('sha256').update(raw, 'utf8').digest('hex') };
				});

				const truncated = content.length > CONTENT_MAX_CHARS;
				const body = truncated ? content.slice(0, CONTENT_MAX_CHARS) : content;

				logCall({
					ts: new Date().toISOString(),
					tool: 'get_note',
					vault: vaultId,
					ok: true,
					ms: Date.now() - start,
					params: { path: relPath }
				});

				return {
					content: [
						{
							type: 'text' as const,
							text: JSON.stringify(
								{ vault: vaultId, path: relPath, hash, frontmatter, content: body, chars: content.length, truncated },
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
					tool: 'get_note',
					vault: vault ?? null,
					ok: false,
					ms: Date.now() - start,
					errorCode: result.content[0].text.split(':')[0],
					params: { path: relPath }
				});
				return result;
			}
		}
	);
}
