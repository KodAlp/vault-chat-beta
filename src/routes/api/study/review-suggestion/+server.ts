import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { computeReviewSuggestion } from '$lib/server/review-mode';
import { vaultFromUrl } from '$lib/server/requestVault';

/**
 * F6 — whether the new-chat composer should OFFER review mode for this vault (TODO #77). Read-only, derived only
 * from learning state (due cards, weak/stale domains, open weak spots) — never from user text. Fails soft to
 * `suggest: false`.
 */
export const GET: RequestHandler = ({ url }) => {
	return json(computeReviewSuggestion(vaultFromUrl(url)));
};
