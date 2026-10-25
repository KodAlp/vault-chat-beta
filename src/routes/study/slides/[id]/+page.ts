import type { PageLoad } from './$types';

/** vaultId — see quiz/[id]/+page.ts's doc comment. */
export const load: PageLoad = ({ params, url }) => {
	return { slideDeckId: params.id, vaultId: url.searchParams.get('vault') ?? undefined };
};
