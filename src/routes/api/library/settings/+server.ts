import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getLibrarySettings, saveLibrarySettings } from '$lib/server/library';
import { vaultFromUrl, vaultFromId } from '$lib/server/requestVault';

export const GET: RequestHandler = async ({ url }) => {
	const v = vaultFromUrl(url);
	return json(getLibrarySettings(v));
};

export const PUT: RequestHandler = async ({ request }) => {
	const body = (await request.json()) as { keepOriginals: boolean; vault?: string };
	const v = vaultFromId(body.vault);
	saveLibrarySettings(v, { keepOriginals: body.keepOriginals });
	return json({ ok: true });
};
