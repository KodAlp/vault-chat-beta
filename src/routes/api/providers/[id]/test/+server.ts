import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getAdapter } from '$lib/server/providers/registry';
import { AppError, fail, toCodedError } from '$lib/server/app-error';
import type { ErrorCode } from '$lib/errors';

export const POST: RequestHandler = async ({ params }) => {
	try {
		const adapter = await getAdapter(params.id);
		const status = await adapter.health();
		return json({ status });
	} catch (err) {
		if (err instanceof AppError) fail(err.code, err.params, err.status);
		const coded = toCodedError(err);
		fail(coded.code as ErrorCode, coded.params, 404);
	}
};
