import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listDomains } from '$lib/server/retrieve';

export const GET: RequestHandler = async () => {
	return json(listDomains());
};
