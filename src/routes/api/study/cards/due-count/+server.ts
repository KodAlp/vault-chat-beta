import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDueCount } from '$lib/server/study-db';

export const GET: RequestHandler = async () => {
	const count = getDueCount(new Date().toISOString());
	return json({ count });
};
