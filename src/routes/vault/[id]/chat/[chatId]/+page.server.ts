import { vaultFromId } from '$lib/server/requestVault';
import { setActiveVault, touchVault } from '$lib/server/vaults';
import { logAppEvent } from '$lib/server/app-log';
import type { PageServerLoad } from './$types';

/** Validates the vault exists (404 otherwise, via vaultFromId's existing
 * error wrapping) and marks it as the one to return to — a direct link
 * into a chat is "using" that vault same as visiting its chat list.
 *
 * setActiveVault/touchVault are bookkeeping, not required for this page's
 * actual content — a registry write failure must never turn "open a chat"
 * into a 500; log it and keep going instead. */
export const load: PageServerLoad = async ({ params }) => {
	const v = vaultFromId(params.id);
	try {
		setActiveVault(v.id);
		touchVault(v.id);
	} catch (err) {
		logAppEvent({
			kind: 'vault_error',
			message: `setActiveVault/touchVault failed for ${v.id}: ${err instanceof Error ? err.message : String(err)}`
		});
	}
	return { vaultName: v.name };
};
