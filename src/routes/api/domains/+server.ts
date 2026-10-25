import type { RequestHandler } from './$types';
import { listDomains } from '#lib/server/retrieve.js';
import { vaultFromUrl } from '#lib/server/requestVault.js';

export const GET: RequestHandler = async ({ url }) => {
	const v = vaultFromUrl(url);
	return Response.json(listDomains(v));
};
