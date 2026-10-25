import type { PageLoad } from './$types';

/** vaultId — see study/quiz/[id]/+page.ts's doc comment; cards
 * had no +page.ts at all before this (its due-queue fetch silently fell
 * back to whatever vault was "active"). */
export const load: PageLoad = ({ url }) => {
	return { vaultId: url.searchParams.get('vault') ?? undefined };
};
