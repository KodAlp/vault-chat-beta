import type { RequestHandler } from './$types';
import { getLibraryTree } from '#lib/server/library.js';
import { vaultFromUrl } from '#lib/server/requestVault.js';

export const GET: RequestHandler = async ({ url }) => {
	const v = vaultFromUrl(url);
	return Response.json({ tree: getLibraryTree(v) });
};
