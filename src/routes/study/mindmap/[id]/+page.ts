import type { PageLoad } from './$types';

/** vaultId (Faz 14) — see quiz/[id]/+page.ts's doc comment. */
export const load: PageLoad = ({ params, url }) => {
	return { mindmapId: params.id, vaultId: url.searchParams.get('vault') ?? undefined };
};
