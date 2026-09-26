import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { setActiveVault } from '$lib/server/vaults';
import { AppError, fail, toCodedError } from '$lib/server/app-error';
import type { ErrorCode } from '$lib/errors';

export const POST: RequestHandler = async ({ params }) => {
	try {
		setActiveVault(params.id);
	} catch (err) {
		if (err instanceof AppError) fail(err.code, err.params, err.status);
		const coded = toCodedError(err);
		fail(coded.code as ErrorCode, coded.params, 404);
	}
	return json({ ok: true });
};
