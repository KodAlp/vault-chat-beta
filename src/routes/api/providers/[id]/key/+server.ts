import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { secretStore, maskKey } from '$lib/server/providers/secrets';

export const POST: RequestHandler = async ({ params, request }) => {
	const body = (await request.json()) as { key?: string };
	if (!body.key || !body.key.trim()) error(400, "'key' boş olamaz");

	await secretStore.set(params.id, body.key.trim());
	return json({ id: params.id, keyStatus: 'connected', mask: maskKey(body.key.trim()) });
};

export const DELETE: RequestHandler = async ({ params }) => {
	await secretStore.delete(params.id);
	return json({ id: params.id, keyStatus: 'none' });
};
