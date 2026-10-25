import type { RequestHandler } from './$types';
import { listMindMaps } from '#lib/server/study-db.js';
import { vaultFromUrl } from '#lib/server/requestVault.js';
import type { StudySummary } from '#lib/types.js';

/** See quizzes/+server.ts for the rationale. */
export const GET: RequestHandler = async ({ url }) => {
	const v = vaultFromUrl(url);
	const items: StudySummary[] = listMindMaps(v).map((r) => ({
		id: r.id,
		title: r.title,
		model: r.model,
		createdAt: r.created_at
	}));
	return Response.json({ items });
};
