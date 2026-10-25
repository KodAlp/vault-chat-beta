import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listSlideDecks } from '$lib/server/study-db';
import { vaultFromUrl } from '$lib/server/requestVault';
import type { StudySummary } from '$lib/types';

/** See quizzes/+server.ts for the rationale. */
export const GET: RequestHandler = async ({ url }) => {
	const v = vaultFromUrl(url);
	const items: StudySummary[] = listSlideDecks(v).map((r) => ({
		id: r.id,
		title: r.title,
		model: r.model,
		createdAt: r.created_at
	}));
	return json({ items });
};
