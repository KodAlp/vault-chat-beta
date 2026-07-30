import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listChats } from '$lib/server/chats-db';
import { vaultFromUrl } from '$lib/server/requestVault';

export const GET: RequestHandler = async ({ url }) => {
	const v = vaultFromUrl(url);
	return json(listChats(v.id));
};
