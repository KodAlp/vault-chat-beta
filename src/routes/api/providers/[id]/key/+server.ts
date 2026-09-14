import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { secretStore, maskKey } from '$lib/server/providers/secrets';
import { readProvidersFile } from '$lib/server/providers/config-store';
import { invalidateAdapter } from '$lib/server/providers/registry';

export const POST: RequestHandler = async ({ params, request }) => {
	const body = (await request.json()) as { key?: string };
	if (!body.key || !body.key.trim()) error(400, "'key' boş olamaz");

	// Nothing checked params.id against a real provider before this — a
	// made-up id would still get written into secrets.json (config-store.ts's
	// writers all keep providers.json/secrets.json in sync by construction;
	// this endpoint was the one path that didn't).
	const known = readProvidersFile().providers.some((p) => p.id === params.id);
	if (!known) error(404, 'Bilinmeyen provider');

	await secretStore.set(params.id, body.key.trim());
	// secrets.json isn't watched by registry.ts's providers.json-mtime cache
	// — without this, the next request for this provider kept reusing an
	// adapter instance built from whatever key (or lack of one) existed
	// before this save.
	invalidateAdapter(params.id);
	return json({ id: params.id, keyStatus: 'connected', mask: maskKey(body.key.trim()) });
};

export const DELETE: RequestHandler = async ({ params }) => {
	await secretStore.delete(params.id);
	invalidateAdapter(params.id);
	return json({ id: params.id, keyStatus: 'none' });
};
