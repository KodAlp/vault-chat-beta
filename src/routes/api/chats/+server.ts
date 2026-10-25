import type { RequestHandler } from './$types';
import { listChats } from '#lib/server/chats-db.js';
import { vaultFromUrl } from '#lib/server/requestVault.js';

export const GET: RequestHandler = async ({ url }) => {
	const v = vaultFromUrl(url);
	return Response.json(listChats(v.id));
};
