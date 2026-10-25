import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { computeWeakSpots } from '$lib/server/learner-store';
import { vaultFromUrl } from '$lib/server/requestVault';

/**
 * Weak spots of a vault: notes (grouped by heading) where a quiz question keeps getting answered wrong or a card
 * keeps being forgotten. Read-only, computed fresh every call — no stored `errors` table (see learner-errors.ts).
 * "Bu soru hatalı" for a quiz question already exists on `PATCH /api/study/quizzes/[id]/items/[itemId]`; no new write
 * route is added here.
 */
export const GET: RequestHandler = ({ url }) => {
	return json(computeWeakSpots(vaultFromUrl(url)));
};
