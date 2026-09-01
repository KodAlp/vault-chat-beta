import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { secretStore, maskKey } from '$lib/server/providers/secrets';
import { readProvidersFile } from '$lib/server/providers/config-store';

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
	return json({ id: params.id, keyStatus: 'connected', mask: maskKey(body.key.trim()) });
};

export const DELETE: RequestHandler = async ({ params }) => {
	await secretStore.delete(params.id);
	return json({ id: params.id, keyStatus: 'none' });
};
