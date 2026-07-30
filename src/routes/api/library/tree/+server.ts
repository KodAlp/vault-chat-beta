import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getLibraryTree } from '$lib/server/library';
import { vaultFromUrl } from '$lib/server/requestVault';

export const GET: RequestHandler = async ({ url }) => {
	const v = vaultFromUrl(url);
	return json({ tree: getLibraryTree(v) });
};
