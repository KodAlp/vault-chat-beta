import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { readProvidersFile, updateChain } from '$lib/server/providers/config-store';
import { fail } from '$lib/server/app-error';

export const GET: RequestHandler = async () => {
	return json(readProvidersFile().chains);
};

export const PATCH: RequestHandler = async ({ request }) => {
	const body = (await request.json()) as { taskType?: string; providerIds?: string[] };
	if (!body.taskType || !Array.isArray(body.providerIds)) {
		fail('VALIDATION_REQUIRED_ALL', { fields: "'taskType', 'providerIds'" });
	}
	updateChain(body.taskType, body.providerIds);
	return json({ taskType: body.taskType, providerIds: body.providerIds });
};
