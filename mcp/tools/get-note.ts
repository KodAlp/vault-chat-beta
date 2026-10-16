import crypto from 'node:crypto';
import { z } from 'zod';
import matter from 'gray-matter';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { readLibraryFile } from '../../src/lib/server/library-read';
import { withVault } from '../vault-scope';
import { logCall } from '../log';
import { toolErrorResult, ToolError } from '../errors';
import { extractSection, pageText, HeadingNotFoundError } from '../../src/lib/server/note-section';

const CONTENT_MAX_CHARS = 200_000;

export function registerGetNote(server: McpServer): void {
	server.registerTool(
		'get_note',
		{
			title: 'Get note',
			description:
				'Read one note by its library-relative path (as returned by search_library or list_sources), ' +
				'with frontmatter parsed out separately from the body, plus the content `hash` of the WHOLE file (pass it as `expected_hash` to edit_note; a section or paged read still returns the whole-file hash). To avoid pulling a big note, pass `heading` (a Markdown heading, exact or case-insensitive; returns that heading through the next heading of the same or higher level, nested headings included, `#` lines inside code blocks ignored) and/or `max_chars` + `offset` (character paging; the result says `next_offset`). Without them the body is returned up to 200000 characters. Rejects any path that resolves outside ' +
				'the vault\'s library root.',
			inputSchema: {
				vault: z.string().optional().describe('Vault id — omit to use the active vault (see list_vaults).'),
				path: z.string().min(1).describe('Library-relative path, e.g. "math/calculus.md".'),
				heading: z.string().min(1).optional().describe('Return only this section (heading text, with or without leading #). Unknown heading → error listing the headings the note has.'),
				max_chars: z.number().int().min(1).max(CONTENT_MAX_CHARS).optional().describe(`Page size in characters (default ${CONTENT_MAX_CHARS}).`),
				offset: z.number().int().min(0).optional().describe('Character offset into the body (or the section) to start from, for paging.')
			},
			annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
		},
		async ({ vault, path: relPath, heading, max_chars, offset }) => {
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
								`"${relPath}" indekste görünüyor olabilir ama diskte yok — indeks bayat olabilir (uygulamada Ayarlar → Kasalar → Yeniden indeksle).`
							);
						}
						throw err;
					}
					const parsed = matter(raw);
					// sha256 of the whole file text (frontmatter included): the `expected_hash` edit_note wants.
					return { vaultId: v.id, frontmatter: parsed.data, content: parsed.content, hash: crypto.createHash('sha256').update(raw, 'utf8').digest('hex') };
				});

				let source = content;
				let section: { heading: string; level: number; matches: number } | undefined;
				if (heading !== undefined) {
					try {
						const s = extractSection(content, heading);
						source = s.text;
						section = { heading: s.heading, level: s.level, matches: s.matches };
					} catch (err) {
						if (err instanceof HeadingNotFoundError) throw new ToolError('HEADING_NOT_FOUND', err.message);
						throw err;
					}
				}
				const page = pageText(source, offset ?? 0, max_chars ?? CONTENT_MAX_CHARS);
				const truncated = page.nextOffset !== null;
				const body = page.text;

				logCall({
					ts: new Date().toISOString(),
					tool: 'get_note',
					vault: vaultId,
					ok: true,
					ms: Date.now() - start,
					params: { path: relPath, heading, max_chars, offset }
				});

				return {
					content: [
						{
							type: 'text' as const,
							text: JSON.stringify(
								{
									vault: vaultId,
									path: relPath,
									hash,
									frontmatter,
									content: body,
									chars: source.length,
									truncated,
									...(section ? { section } : {}),
									...(truncated || page.offset > 0 ? { offset: page.offset, next_offset: page.nextOffset } : {})
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
					tool: 'get_note',
					vault: vault ?? null,
					ok: false,
					ms: Date.now() - start,
					errorCode: result.content[0].text.split(':')[0],
					params: { path: relPath, heading, max_chars, offset }
				});
				return result;
			}
		}
	);
}
