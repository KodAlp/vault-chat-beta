import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listReports } from '$lib/server/study-db';
import { vaultFromUrl } from '$lib/server/requestVault';
import type { StudySummary } from '$lib/types';

/** Faz 13 — see quizzes/+server.ts for the rationale. */
export const GET: RequestHandler = async ({ url }) => {
	const v = vaultFromUrl(url);
	const items: StudySummary[] = listReports(v).map((r) => ({
		id: r.id,
		title: r.title,
		model: r.model,
		createdAt: r.created_at
	}));
	return json({ items });
};
