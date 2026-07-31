import { vaultFromId } from '$lib/server/requestVault';
import { setActiveVault, touchVault } from '$lib/server/vaults';
import type { PageServerLoad } from './$types';

/** Visiting a vault's chat list is "using" that vault — same reasoning as
 * the chat route's own load (src/routes/vault/[id]/chat/[chatId]/+page.server.ts):
 * marks it active so `/`'s auto-redirect (no new client state, see
 * frontend-revamp skill) picks it up next time. */
export const load: PageServerLoad = async ({ params }) => {
	const v = vaultFromId(params.id);
	setActiveVault(v.id);
	touchVault(v.id);
	return { vaultId: v.id, vaultName: v.name };
};
