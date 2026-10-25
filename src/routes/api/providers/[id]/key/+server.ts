import type { RequestHandler } from './$types';
import { secretStore, maskKey } from '#lib/server/providers/secrets.js';
import { readProvidersFile } from '#lib/server/providers/config-store.js';
import { invalidateAdapter } from '#lib/server/providers/registry.js';
import { fail } from '#lib/server/app-error.js';

export const POST: RequestHandler = async ({ params, request }) => {
	const body = (await request.json()) as { key?: string };
	if (!body.key || !body.key.trim()) fail('VALIDATION_EMPTY_FIELD', { field: "'key'" });

	// Nothing checked params.id against a real provider before this — a
	// made-up id would still get written into secrets.json (config-store.ts's
	// writers all keep providers.json/secrets.json in sync by construction;
	// this endpoint was the one path that didn't).
	const known = readProvidersFile().providers.some((p) => p.id === params.id);
	if (!known) fail('NOT_FOUND', { entity: 'provider', detail: params.id }, 404);

	await secretStore.set(params.id, body.key.trim());
	// secrets.json isn't watched by registry.ts's providers.json-mtime cache
	// — without this, the next request for this provider kept reusing an
	// adapter instance built from whatever key (or lack of one) existed
	// before this save.
	invalidateAdapter(params.id);
	return Response.json({ id: params.id, keyStatus: 'connected', mask: maskKey(body.key.trim()) });
};

export const DELETE: RequestHandler = async ({ params }) => {
	await secretStore.delete(params.id);
	invalidateAdapter(params.id);
	return Response.json({ id: params.id, keyStatus: 'none' });
};
