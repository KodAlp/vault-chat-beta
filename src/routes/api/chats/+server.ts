import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listChats } from '$lib/server/chats-db';

export const GET: RequestHandler = async () => {
	return json(listChats());
};
