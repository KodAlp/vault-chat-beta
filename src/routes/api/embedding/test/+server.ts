import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { measureEmbeddingDims } from '$lib/server/embeddings';
import { AppError, fail, toCodedError } from '$lib/server/app-error';
import type { ErrorCode } from '$lib/errors';

/**
 * One real embed call against an arbitrary provider/model pair
 * (measureEmbeddingDims, embeddings.ts), so the future settings UI's "Test
 * et" button can fill in `dims` before the user saves an
 * embedding config, instead of asking them to know a model's vector size.
 * Deliberately separate from PUT /api/embedding: testing a pair must never
 * itself change the saved config.
 */
export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json().catch(() => null)) as { providerId?: string; model?: string } | null;
	if (!body?.providerId) fail('VALIDATION_REQUIRED', { field: 'providerId' });
	if (!body?.model) fail('VALIDATION_REQUIRED', { field: 'model' });

	try {
		const dims = await measureEmbeddingDims(body.providerId, body.model);
		return json({ dims });
	} catch (err) {
		if (err instanceof AppError) fail(err.code, err.params, err.status);
		const coded = toCodedError(err);
		fail(coded.code as ErrorCode, coded.params, 400);
	}
};
