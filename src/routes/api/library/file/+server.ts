import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { readLibraryFile, deleteLibraryEntry } from '#lib/server/library.js';
import { vaultFromUrl, vaultFromId } from '#lib/server/requestVault.js';
import { fail, toCodedError, AppError } from '#lib/server/app-error.js';
import { sha256, writeLibraryFile } from '#lib/server/library-write.js';
import type { ErrorCode } from '#lib/errors.js';

export const GET: RequestHandler = async ({ url }) => {
	const v = vaultFromUrl(url);
	const path = url.searchParams.get('path');
	if (!path) fail('VALIDATION_REQUIRED', { field: 'path' });
	try {
		const raw = readLibraryFile(v, path);
		// `hash` is the optimistic-lock token a later PUT sends back as baseHash.
		return json({ path, raw, hash: sha256(raw) });
	} catch {
		// Conflates "path resolves outside the library" and "file doesn't
		// exist" into one 404, same as before — not distinguishing the two
		// is deliberate (avoids confirming/denying a traversal attempt).
		fail('NOT_FOUND', { entity: 'file' }, 404);
	}
};

export const DELETE: RequestHandler = async ({ request }) => {
	const body = (await request.json()) as { path: string; vault?: string };
	const v = vaultFromId(body.vault);
	try {
		deleteLibraryEntry(v, body.path);
	} catch (err) {
		const c = toCodedError(err);
		fail(c.code as ErrorCode, c.params, 400);
	}
	return json({ ok: true });
};

/**
 * Manual edit from the viewer page. The ONLY write door for source notes —
 * the MCP server never reaches library-write.ts (see mcp/no-write-import.test.ts).
 * Keeps the AppError's own status (409 conflict, 413 too large, 400 rest)
 * instead of flattening to 400 like DELETE does.
 */
export const PUT: RequestHandler = async ({ request }) => {
	const body = (await request.json()) as { path?: string; vault?: string; content?: string; baseHash?: string };
	if (!body.path) fail('VALIDATION_REQUIRED', { field: 'path' });
	if (typeof body.content !== 'string') fail('VALIDATION_REQUIRED', { field: 'content' });
	if (!body.baseHash) fail('VALIDATION_REQUIRED', { field: 'baseHash' });
	const v = vaultFromId(body.vault);
	try {
		return json(await writeLibraryFile(v, body.path, body.content, body.baseHash, { by: 'user' }));
	} catch (err) {
		const c = toCodedError(err);
		fail(c.code as ErrorCode, c.params, err instanceof AppError ? err.status : 500);
	}
};
