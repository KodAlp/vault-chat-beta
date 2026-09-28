import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getEmbeddingConfig, setEmbeddingConfig, type EmbeddingConfig } from '$lib/server/providers/config-store';
import { AppError, fail, toCodedError } from '$lib/server/app-error';
import type { ErrorCode } from '$lib/errors';

/**
 * Aşama 3a — settings surface for providers/config-store.ts's embedding
 * config. GET is read-only (no side effects, matches every other settings
 * GET in this app — e.g. api/library/settings). PUT validates through
 * setEmbeddingConfig() (provider exists/enabled/kind, dims, consent for a
 * cloud provider) and never partially applies a bad config: a validation
 * failure leaves the previously saved embedding block untouched.
 *
 * No UI reads this yet (Aşama 3c) — this route exists now so the backend
 * contract is settled before that phase writes the settings card against it.
 */
export const GET: RequestHandler = async () => {
	return json(getEmbeddingConfig());
};

export const PUT: RequestHandler = async ({ request }) => {
	const body = (await request.json().catch(() => null)) as Partial<EmbeddingConfig> | null;
	if (!body?.providerId) fail('VALIDATION_REQUIRED', { field: 'providerId' });
	if (!body?.model) fail('VALIDATION_REQUIRED', { field: 'model' });
	if (body?.dims === undefined || body.dims === null) fail('VALIDATION_REQUIRED', { field: 'dims' });

	try {
		setEmbeddingConfig({
			providerId: body.providerId,
			model: body.model,
			dims: body.dims,
			...(body.distanceThreshold !== undefined ? { distanceThreshold: body.distanceThreshold } : {})
		});
		return json(getEmbeddingConfig());
	} catch (err) {
		if (err instanceof AppError) fail(err.code, err.params, err.status);
		const coded = toCodedError(err);
		fail(coded.code as ErrorCode, coded.params, 400);
	}
};
