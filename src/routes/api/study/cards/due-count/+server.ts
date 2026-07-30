import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDueCount } from '$lib/server/study-db';
import { vaultFromUrl } from '$lib/server/requestVault';

export const GET: RequestHandler = async ({ url }) => {
	const v = vaultFromUrl(url);
	const count = getDueCount(v, new Date().toISOString());
	return json({ count });
};
