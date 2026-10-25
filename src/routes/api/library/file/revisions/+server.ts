import type { RequestHandler } from './$types';
import { listRevisions, readRevision, restoreRevision } from '#lib/server/library-write.js';
import { vaultFromUrl, vaultFromId } from '#lib/server/requestVault.js';
import { fail, toCodedError, AppError } from '#lib/server/app-error.js';
import type { ErrorCode } from '#lib/errors.js';

function failFrom(err: unknown): never {
	const c = toCodedError(err);
	return fail(c.code as ErrorCode, c.params, err instanceof AppError ? err.status : 500);
}

/** No `id` -> the revision list (newest first); with `id` -> that revision's raw text. */
export const GET: RequestHandler = async ({ url }) => {
	const v = vaultFromUrl(url);
	const path = url.searchParams.get('path');
	if (!path) fail('VALIDATION_REQUIRED', { field: 'path' });
	const id = url.searchParams.get('id');
	try {
		if (id) return Response.json({ raw: readRevision(v, path, id) });
		return Response.json({ revisions: listRevisions(v, path) });
	} catch (err) {
		failFrom(err);
	}
};

/** Restore = a normal save of the old text (snapshots the current one first). */
export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json()) as { path?: string; vault?: string; id?: string; baseHash?: string };
	if (!body.path) fail('VALIDATION_REQUIRED', { field: 'path' });
	if (!body.id) fail('VALIDATION_REQUIRED', { field: 'id' });
	if (!body.baseHash) fail('VALIDATION_REQUIRED', { field: 'baseHash' });
	const v = vaultFromId(body.vault);
	try {
		return Response.json(await restoreRevision(v, body.path, body.id, body.baseHash));
	} catch (err) {
		failFrom(err);
	}
};
