import { error } from '@sveltejs/kit';
import { resolveVault, type VaultContext } from './vaults';

/**
 * Bridge until Faz 9's /vault/[id]/... routes exist: reads an explicit
 * `?vault=<id>` query param, falls back to the active vault when absent.
 * Faz 8's own UI never sends the param (single active-vault workflow) —
 * this only exists so route signatures don't have to change again once
 * Faz 9 starts sending it. See vault-registry skill.
 */
export function vaultFromUrl(url: URL): VaultContext {
	const id = url.searchParams.get('vault');
	try {
		return resolveVault(id);
	} catch (e) {
		error(404, e instanceof Error ? e.message : 'Vault bulunamadı');
	}
}

/** Same resolution, for routes that take the vault id from a JSON body
 * field instead of a query param (POST handlers with a request body). */
export function vaultFromId(id?: string | null): VaultContext {
	try {
		return resolveVault(id);
	} catch (e) {
		error(404, e instanceof Error ? e.message : 'Vault bulunamadı');
	}
}
