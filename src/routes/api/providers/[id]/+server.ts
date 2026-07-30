import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { updateProviderEnabled } from '$lib/server/providers/config-store';

export const PATCH: RequestHandler = async ({ params, request }) => {
	const body = (await request.json()) as { enabled?: boolean };
	if (typeof body.enabled !== 'boolean') error(400, "'enabled' boolean olmalı");

	try {
		const entry = updateProviderEnabled(params.id, body.enabled);
		return json({ id: entry.id, enabled: entry.enabled });
	} catch (err) {
		error(404, err instanceof Error ? err.message : 'Bilinmeyen provider');
	}
};
