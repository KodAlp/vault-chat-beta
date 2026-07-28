import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listModels } from '$lib/server/ollama';

export const GET: RequestHandler = async () => {
	try {
		const models = await listModels();
		return json(models);
	} catch (err) {
		return json(
			{ error: err instanceof Error ? err.message : 'Ollama sunucusuna ulaşılamadı' },
			{ status: 502 }
		);
	}
};
