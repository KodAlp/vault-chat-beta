import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { fail, toCodedError, AppError } from '$lib/server/app-error';
import { readMcpSettings } from '$lib/server/mcp-settings';
import { requireMcpVault } from '$lib/server/mcp-import';
import { readLibraryFile } from '$lib/server/library-read';
import { writeLibraryFile } from '$lib/server/library-write';
import { applyNoteEdit, type NoteEdit } from '$lib/server/mcp-edit-note';
import type { ErrorCode } from '$lib/errors';

/**
 * edit_note: lets an MCP client change ONE existing .md note, and only while the user has switched
 * "allow edit_note" on in Settings (mcp-settings.ts; the MCP token cannot reach that setting).
 *
 * The switch is checked here, in the app, first of all: the MCP process is not trusted to enforce it.
 * Everything after that reuses the manual-edit door (library-write.ts): path gate (inside the library, .md
 * only, not _meta, regular non-symlink file), base-hash conflict check, revision snapshot (so every agent
 * edit is undoable from the note's revision list), atomic replace, edit-log (by: 'mcp') and reindex of
 * that one note. The frontmatter is never editable (see mcp-edit-note.ts).
 */
export const POST: RequestHandler = async ({ request }) => {
	if (!readMcpSettings().allowEditNote) fail('MCP_EDIT_NOTE_DISABLED', undefined, 403);

	const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
	if (typeof body !== 'object' || body === null || Array.isArray(body)) fail('VALIDATION_INVALID', { field: 'body' });
	const relPath = body.path;
	if (typeof relPath !== 'string' || relPath.length === 0 || relPath.length > 1024 || relPath.includes('\0')) {
		fail('VALIDATION_REQUIRED', { field: 'path' });
	}
	if (typeof body.expectedHash !== 'string' || !/^[0-9a-f]{64}$/.test(body.expectedHash)) {
		fail('VALIDATION_REQUIRED', { field: 'expectedHash' });
	}
	const hasContent = typeof body.content === 'string';
	const hasReplace = typeof body.oldString === 'string' || typeof body.newString === 'string';
	if (hasContent === hasReplace) fail('VALIDATION_INVALID', { field: 'content|oldString' });
	let edit: NoteEdit;
	if (hasContent) {
		edit = { content: body.content as string };
	} else {
		if (typeof body.oldString !== 'string' || typeof body.newString !== 'string') {
			fail('VALIDATION_REQUIRED', { field: typeof body.oldString === 'string' ? 'newString' : 'oldString' });
		}
		edit = { oldString: body.oldString, newString: body.newString };
	}

	try {
		const v = requireMcpVault(body.vault);
		if (!relPath.toLowerCase().endsWith('.md')) throw new AppError('LIBRARY_EDIT_FORBIDDEN', undefined, 400);
		let raw: string;
		try {
			raw = readLibraryFile(v, relPath);
		} catch (err) {
			// Same as the viewer's GET: a missing file and a traversal attempt answer alike.
			throw new AppError(
				(err as { name?: string }).name === 'PathOutsideLibraryError' ? 'PATH_OUTSIDE_LIBRARY' : 'NOT_FOUND',
				(err as { name?: string }).name === 'PathOutsideLibraryError' ? undefined : { entity: 'file' },
				(err as { name?: string }).name === 'PathOutsideLibraryError' ? 400 : 404
			);
		}
		const next = applyNoteEdit(raw, body.expectedHash, edit);
		// The write re-checks the same hash against the file on disk, so a change between our read and the
		// write is still a conflict, never a lost update.
		const result = await writeLibraryFile(v, relPath, next, body.expectedHash, { by: 'mcp' });
		return json({ path: relPath, hash: result.hash, indexPending: result.indexPending, bytes: Buffer.byteLength(next, 'utf8') });
	} catch (err) {
		if (err instanceof AppError) fail(err.code as ErrorCode, err.params, err.status);
		const c = toCodedError(err);
		fail(c.code as ErrorCode, c.params, 500);
	}
};
