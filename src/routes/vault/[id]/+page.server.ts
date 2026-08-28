import { vaultFromId } from '$lib/server/requestVault';
import { markVaultUsed } from '$lib/server/vaults';
import { logAppEvent } from '$lib/server/app-log';
import type { PageServerLoad } from './$types';

/** Visiting a vault's chat list is "using" that vault — same reasoning as
 * the chat route's own load (src/routes/vault/[id]/chat/[chatId]/+page.server.ts):
 * marks it active so `/`'s auto-redirect (no new client state, see
 * frontend-revamp skill) picks it up next time.
 *
 * markVaultUsed is bookkeeping (remembers last-used vault,
 * updates a timestamp) — not required for this page's actual content, which
 * loads separately via client-side fetches keyed by params.id. A registry
 * write failure (AV lock, EPERM, ...) must never turn "open a vault" into a
 * 500; log it and keep going instead. */
export const load: PageServerLoad = async ({ params }) => {
	const v = vaultFromId(params.id);
	try {
		markVaultUsed(v.id);
	} catch (err) {
		logAppEvent({
			kind: 'vault_error',
			message: `markVaultUsed failed for ${v.id}: ${err instanceof Error ? err.message : String(err)}`
		});
	}
	return { vaultId: v.id, vaultName: v.name };
};
