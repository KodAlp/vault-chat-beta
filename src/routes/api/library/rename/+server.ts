import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { renameLibraryEntry } from '$lib/server/library';
import { vaultFromId } from '$lib/server/requestVault';
import { fail, toCodedError } from '$lib/server/app-error';
import type { ErrorCode } from '$lib/errors';

export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json()) as { oldPath: string; newPath: string; vault?: string };
	const v = vaultFromId(body.vault);
	try {
		renameLibraryEntry(v, body.oldPath, body.newPath);
	} catch (err) {
		const c = toCodedError(err);
		fail(c.code as ErrorCode, c.params, 400);
	}
	return json({ ok: true });
};
