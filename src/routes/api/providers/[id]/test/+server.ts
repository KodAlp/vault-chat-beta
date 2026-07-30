import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getAdapter } from '$lib/server/providers/registry';

export const POST: RequestHandler = async ({ params }) => {
	try {
		const adapter = await getAdapter(params.id);
		const status = await adapter.health();
		return json({ status });
	} catch (err) {
		error(404, err instanceof Error ? err.message : 'Bilinmeyen provider');
	}
};
