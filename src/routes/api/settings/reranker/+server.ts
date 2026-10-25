import type { RequestHandler } from './$types';
import { getRerankerConfig, setRerankerConfig } from '#lib/server/providers/config-store.js';
import { downloadRerankerModel, rerankerModelPresent, rerankerStatus } from '#lib/server/reranker.js';
import { AppError, fail } from '#lib/server/app-error.js';
import { logAppEvent } from '#lib/server/app-log.js';

/**
 * Chat reranker settings (reranker.ts). Session-gated and same-origin-checked by hooks.server.ts like
 * every other /api/settings route. GET: `{ enabled, pythonOk, cuda, modelPresent, running, downloading }`
 * (the first call spends a few seconds importing torch to learn about CUDA). POST `{ enabled }` switches
 * it; POST `{ action: 'download' }` fetches the ~2.3 GB model and answers when it is in the cache.
 */
export const GET: RequestHandler = async () => {
	return Response.json(await rerankerStatus());
};

export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json().catch(() => null)) as { enabled?: unknown; action?: unknown } | null;
	if (typeof body !== 'object' || body === null || Array.isArray(body)) fail('VALIDATION_INVALID', { field: 'body' });

	if (body.action === 'download') {
		try {
			await downloadRerankerModel();
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err);
			logAppEvent({ kind: 'reranker_issue', message: `reranker modeli indirilemedi: ${detail}` });
			fail('RERANKER_DOWNLOAD_FAILED', { detail });
		}
		return Response.json(await rerankerStatus());
	}

	if (typeof body.enabled !== 'boolean') fail('VALIDATION_INVALID', { field: 'enabled' });
	// Without the weights every chat message would log a miss: ask for the download first.
	if (body.enabled && !rerankerModelPresent()) fail('RERANKER_MODEL_MISSING');
	try {
		setRerankerConfig({ enabled: body.enabled });
	} catch (err) {
		if (err instanceof AppError) fail(err.code, err.params, err.status);
		throw err;
	}
	return Response.json({ ...(await rerankerStatus()), enabled: getRerankerConfig().enabled });
};
