import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { readProvidersFile, updateChain } from '$lib/server/providers/config-store';

export const GET: RequestHandler = async () => {
	return json(readProvidersFile().chains);
};

export const PATCH: RequestHandler = async ({ request }) => {
	const body = (await request.json()) as { taskType?: string; providerIds?: string[] };
	if (!body.taskType || !Array.isArray(body.providerIds)) {
		error(400, "'taskType' ve 'providerIds' gerekli");
	}
	updateChain(body.taskType, body.providerIds);
	return json({ taskType: body.taskType, providerIds: body.providerIds });
};
