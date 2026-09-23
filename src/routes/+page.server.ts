import { redirect } from '@sveltejs/kit';
import { listVaults, getActiveVaultId, contextFor } from '$lib/server/vaults';
import { countUnindexedFiles } from '$lib/server/retrieve';
import type { PageServerLoad } from './$types';

/**
 * "Son vault'u hatırlama" — no new client state (see frontend-revamp
 * skill's Adım 5-7 plan, kullanıcı onayı): reuses Faz 8's existing
 * activeVaultId registry field, already kept up to date by
 * setActiveVault() calls in the vault/[id] routes. `?picker=1` is the
 * escape hatch — the header's "back to vault picker" link needs a way to
 * actually reach this page instead of bouncing straight back through the
 * same redirect it just arrived from.
 */
export const load: PageServerLoad = async ({ url }) => {
	const vaults = listVaults();

	if (!url.searchParams.has('picker')) {
		if (vaults.length === 1) redirect(307, `/vault/${vaults[0].id}`);
		if (vaults.length > 1) {
			const activeId = getActiveVaultId();
			if (activeId) redirect(307, `/vault/${activeId}`);
		}
	}

	// unindexedCount, not stored on VaultRecord (see api/vaults/+server.ts's
	// doc comment) — the vault picker's cards show it via VaultCard.svelte.
	return { vaults: vaults.map((v) => ({ ...v, unindexedCount: countUnindexedFiles(contextFor(v)) })) };
};
