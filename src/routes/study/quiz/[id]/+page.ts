import type { PageLoad } from './$types';

/** `vaultId` (Faz 14) — without it the page's own API calls and its
 * source-file links both silently fall back to whatever vault happens to
 * be "active", which is wrong the moment that's not the vault this quiz
 * was actually generated in. */
export const load: PageLoad = ({ params, url }) => {
	return { quizId: params.id, vaultId: url.searchParams.get('vault') ?? undefined };
};
