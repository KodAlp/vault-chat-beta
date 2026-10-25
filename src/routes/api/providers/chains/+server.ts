import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { readProvidersFile, updateChain } from '#lib/server/providers/config-store.js';
import { AppError, fail, toCodedError } from '#lib/server/app-error.js';
import type { ErrorCode } from '#lib/errors.js';

export const GET: RequestHandler = async () => {
	return json(readProvidersFile().chains);
};

export const PATCH: RequestHandler = async ({ request }) => {
	const body = (await request.json()) as { taskType?: string; providerIds?: string[] };
	if (!body.taskType || !Array.isArray(body.providerIds)) {
		fail('VALIDATION_REQUIRED_ALL', { fields: "'taskType', 'providerIds'" });
	}
	try {
		// updateChain validates: the ids must exist, no duplicates, strings only.
		updateChain(body.taskType, body.providerIds);
	} catch (err) {
		if (err instanceof AppError) fail(err.code, err.params, err.status);
		const coded = toCodedError(err);
		fail(coded.code as ErrorCode, coded.params, 400);
	}
	return json({ taskType: body.taskType, providerIds: body.providerIds });
};
