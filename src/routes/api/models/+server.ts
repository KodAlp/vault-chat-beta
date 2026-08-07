import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getAdapter } from '$lib/server/providers/registry';
import { OllamaAdapter } from '$lib/server/providers/ollama';

async function getOllamaAdapter(): Promise<OllamaAdapter> {
	const adapter = await getAdapter('ollama');
	if (!(adapter instanceof OllamaAdapter)) throw new Error('ollama adapter kayıtlı değil');
	return adapter;
}

export const GET: RequestHandler = async () => {
	try {
		// Only Ollama is enabled today; native listing carries size/modified_at
		// that the cross-provider ModelInfo shape doesn't (see ollama.ts) —
		// response shape unchanged from the client's perspective.
		const adapter = await getOllamaAdapter();
		const models = await adapter.listNativeModels();
		return json(models);
	} catch (err) {
		return json(
			{ error: err instanceof Error ? err.message : 'Ollama sunucusuna ulaşılamadı' },
			{ status: 502 }
		);
	}
};

/** Pull a model from Ollama's registry, streaming progress as SSE — same
 * pattern as /api/import's conversion progress. A download can run for
 * minutes, so this is a stream, not a blocking JSON response. */
export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json().catch(() => null)) as { model?: string } | null;
	const model = body?.model?.trim();
	if (!model) return json({ error: 'model gerekli' }, { status: 400 });

	const stream = new ReadableStream({
		async start(controller) {
			const encoder = new TextEncoder();
			const send = (event: { type: string; status?: string; error?: string }) =>
				controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
			try {
				const adapter = await getOllamaAdapter();
				await adapter.pull(model, (status) => send({ type: 'progress', status }));
				send({ type: 'done' });
			} catch (err) {
				send({ type: 'error', error: err instanceof Error ? err.message : 'Bilinmeyen hata' });
			} finally {
				controller.close();
			}
		}
	});

	return new Response(stream, {
		headers: {
			'content-type': 'text/event-stream',
			'cache-control': 'no-cache',
			connection: 'keep-alive'
		}
	});
};

/** Delete an installed model. */
export const DELETE: RequestHandler = async ({ request }) => {
	const body = (await request.json().catch(() => null)) as { model?: string } | null;
	const model = body?.model?.trim();
	if (!model) return json({ error: 'model gerekli' }, { status: 400 });
	try {
		const adapter = await getOllamaAdapter();
		await adapter.delete(model);
		return json({ ok: true });
	} catch (err) {
		return json({ error: err instanceof Error ? err.message : 'Silinemedi' }, { status: 400 });
	}
};