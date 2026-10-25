import type { RequestHandler } from './$types';
import { computeReviewSuggestion } from '#lib/server/review-mode.js';
import { vaultFromUrl } from '#lib/server/requestVault.js';

/**
 * Whether the new-chat composer should OFFER review mode for this vault. Read-only, derived only
 * from learning state (due cards, weak/stale domains, open weak spots) — never from user text. Fails soft to
 * `suggest: false`.
 */
export const GET: RequestHandler = ({ url }) => {
	return Response.json(computeReviewSuggestion(vaultFromUrl(url)));
};
