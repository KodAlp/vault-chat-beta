import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getAdapter } from '$lib/server/providers/registry';
import { OllamaAdapter } from '$lib/server/providers/ollama';
import { sseStream } from '$lib/server/sse';
import { logAppEvent } from '$lib/server/app-log';
import { AppError, fail, toCodedError, errorPayload } from '$lib/server/app-error';
import type { ErrorCode, ErrorParams } from '$lib/errors';

type PullEvent = { type: string; status?: string; error?: string; code?: string; params?: ErrorParams };

async function getOllamaAdapter(): Promise<OllamaAdapter> {
	const adapter = await getAdapter('ollama');
	if (!(adapter instanceof OllamaAdapter)) throw new AppError('PROVIDER_OLLAMA_MISCONFIGURED');
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
		if (err instanceof AppError) fail(err.code, err.params, err.status);
		const coded = toCodedError(err);
		fail(coded.code as ErrorCode, coded.params, 502);
	}
};

/** Pull a model from Ollama's registry, streaming progress as SSE — same
 * pattern as /api/import's conversion progress. A download can run for
 * minutes, so this is a stream, not a blocking JSON response. */
export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json().catch(() => null)) as { model?: string } | null;
	const model = body?.model?.trim();
	if (!model) fail('VALIDATION_REQUIRED', { field: 'model' });

	// sseStream, not a bare ReadableStream — same crash this fixed for the
	// five /api/generate/* routes and for the import routes: a model pull can
	// take minutes for a multi-GB download, making it the single most likely
	// stream in this app to be abandoned mid-flight. An abandoned pull used to
	// throw an unhandled error out of the next progress send() and take the
	// whole server down instead of just this one request.
	return sseStream<PullEvent>(async (send) => {
		try {
			const adapter = await getOllamaAdapter();
			await adapter.pull(model, (status) => send({ type: 'progress', status }));
			send({ type: 'done' });
		} catch (err) {
			const coded = errorPayload(err);
			send({ type: 'error', error: coded.message, code: coded.code, params: coded.params });
		}
	}, (message) => logAppEvent({ kind: 'fatal_error', message: `model pull stream: ${message}` }));
};

/** Delete an installed model. */
export const DELETE: RequestHandler = async ({ request }) => {
	const body = (await request.json().catch(() => null)) as { model?: string } | null;
	const model = body?.model?.trim();
	if (!model) fail('VALIDATION_REQUIRED', { field: 'model' });
	try {
		const adapter = await getOllamaAdapter();
		await adapter.delete(model);
		return json({ ok: true });
	} catch (err) {
		if (err instanceof AppError) fail(err.code, err.params, err.status);
		const coded = toCodedError(err);
		fail(coded.code as ErrorCode, coded.params, 400);
	}
};
