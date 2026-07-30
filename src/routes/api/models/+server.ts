import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getAdapter } from '$lib/server/providers/registry';
import { OllamaAdapter } from '$lib/server/providers/ollama';

export const GET: RequestHandler = async () => {
	try {
		// Only Ollama is enabled today; native listing carries size/modified_at
		// that the cross-provider ModelInfo shape doesn't (see ollama.ts) —
		// response shape unchanged from the client's perspective.
		const adapter = await getAdapter('ollama');
		if (!(adapter instanceof OllamaAdapter)) throw new Error('ollama adapter kayıtlı değil');
		const models = await adapter.listNativeModels();
		return json(models);
	} catch (err) {
		return json(
			{ error: err instanceof Error ? err.message : 'Ollama sunucusuna ulaşılamadı' },
			{ status: 502 }
		);
	}
};
