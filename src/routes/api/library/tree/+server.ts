import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getLibraryTree } from '$lib/server/library';

export const GET: RequestHandler = async () => {
	return json({ tree: getLibraryTree() });
};
