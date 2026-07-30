import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listDomains } from '$lib/server/retrieve';
import { vaultFromUrl } from '$lib/server/requestVault';

export const GET: RequestHandler = async ({ url }) => {
	const v = vaultFromUrl(url);
	return json(listDomains(v));
};
