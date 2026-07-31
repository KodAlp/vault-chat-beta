import { vaultFromId } from '$lib/server/requestVault';
import { setActiveVault, touchVault } from '$lib/server/vaults';
import type { PageServerLoad } from './$types';

/** Validates the vault exists (404 otherwise, via vaultFromId's existing
 * error wrapping) and marks it as the one to return to — a direct link
 * into a chat is "using" that vault same as visiting its chat list. */
export const load: PageServerLoad = async ({ params }) => {
	const v = vaultFromId(params.id);
	setActiveVault(v.id);
	touchVault(v.id);
	return { vaultName: v.name };
};
