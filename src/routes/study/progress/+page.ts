import type { PageLoad } from './$types';

/** vaultId — same handling as study/cards/+page.ts: an absent `vault` param falls back to the active vault server-side. */
export const load: PageLoad = ({ url }) => {
	return { vaultId: url.searchParams.get('vault') ?? undefined };
};
