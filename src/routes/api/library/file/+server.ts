import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { readLibraryFile, deleteLibraryEntry } from '$lib/server/library';
import { vaultFromUrl, vaultFromId } from '$lib/server/requestVault';
import { fail, toCodedError } from '$lib/server/app-error';
import type { ErrorCode } from '$lib/errors';

export const GET: RequestHandler = async ({ url }) => {
	const v = vaultFromUrl(url);
	const path = url.searchParams.get('path');
	if (!path) fail('VALIDATION_REQUIRED', { field: 'path' });
	try {
		return json({ path, raw: readLibraryFile(v, path) });
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
