import type { RequestHandler } from './$types';
import { renameLibraryEntry } from '#lib/server/library.js';
import { vaultFromId } from '#lib/server/requestVault.js';
import { fail, toCodedError } from '#lib/server/app-error.js';
import type { ErrorCode } from '#lib/errors.js';

export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json()) as { oldPath: string; newPath: string; vault?: string };
	const v = vaultFromId(body.vault);
	try {
		renameLibraryEntry(v, body.oldPath, body.newPath);
	} catch (err) {
		const c = toCodedError(err);
		fail(c.code as ErrorCode, c.params, 400);
	}
	return Response.json({ ok: true });
};
