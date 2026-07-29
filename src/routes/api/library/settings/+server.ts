import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getLibrarySettings, saveLibrarySettings } from '$lib/server/library';

export const GET: RequestHandler = async () => {
	return json(getLibrarySettings());
};

export const PUT: RequestHandler = async ({ request }) => {
	const body = (await request.json()) as { keepOriginals: boolean };
	saveLibrarySettings(body);
	return json({ ok: true });
};
