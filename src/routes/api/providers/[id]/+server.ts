import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { updateProviderEnabled, updateProviderDefaultModel } from '$lib/server/providers/config-store';

export const PATCH: RequestHandler = async ({ params, request }) => {
	const body = (await request.json()) as { enabled?: boolean; defaultModel?: string | null };
	if (body.enabled === undefined && body.defaultModel === undefined) {
		error(400, "'enabled' veya 'defaultModel' gerekli");
	}
	if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
		error(400, "'enabled' boolean olmalı");
	}

	try {
		if (body.enabled !== undefined) {
			updateProviderEnabled(params.id, body.enabled);
		}
		if (body.defaultModel !== undefined) {
			updateProviderDefaultModel(params.id, body.defaultModel);
		}
		return json({ id: params.id, enabled: body.enabled, defaultModel: body.defaultModel });
	} catch (err) {
		error(404, err instanceof Error ? err.message : 'Bilinmeyen provider');
	}
};
