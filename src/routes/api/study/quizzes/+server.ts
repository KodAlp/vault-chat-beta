import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listQuizzes } from '$lib/server/study-db';
import { vaultFromUrl } from '$lib/server/requestVault';
import type { StudySummary } from '$lib/types';

/** Faz 13 — the collection-level counterpart to [id]/+server.ts's
 * get-by-id: lets the UI show what's already been generated in this
 * vault, not just fetch a specific item once its id is already known. */
export const GET: RequestHandler = async ({ url }) => {
	const v = vaultFromUrl(url);
	const items: StudySummary[] = listQuizzes(v).map((r) => ({
		id: r.id,
		title: r.title,
		model: r.model,
		createdAt: r.created_at
	}));
	return json({ items });
};
