import type { RequestHandler } from './$types';
import { setActiveVault } from '#lib/server/vaults.js';
import { AppError, fail, toCodedError } from '#lib/server/app-error.js';
import type { ErrorCode } from '#lib/errors.js';

export const POST: RequestHandler = async ({ params }) => {
	try {
		setActiveVault(params.id);
	} catch (err) {
		if (err instanceof AppError) fail(err.code, err.params, err.status);
		const coded = toCodedError(err);
		fail(coded.code as ErrorCode, coded.params, 404);
	}
	return Response.json({ ok: true });
};
