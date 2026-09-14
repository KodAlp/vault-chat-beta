import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDueCount } from '$lib/server/study-db';
import { vaultFromUrl } from '$lib/server/requestVault';

export const GET: RequestHandler = async ({ url }) => {
	const v = vaultFromUrl(url);
	// Optional per-deck scoping — StudyPanel's per-deck due badge.
	const deckId = url.searchParams.get('deck') ?? undefined;
	const count = getDueCount(v, new Date().toISOString(), deckId);
	return json({ count });
};
