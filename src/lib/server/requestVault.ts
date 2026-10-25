import { resolveVault, type VaultContext } from './vaults';
import { AppError, fail } from './app-error';

/** resolveVault throws a coded AppError (VAULT_NONE / NOT_FOUND{vault}); keep its code so the client can localize it
 * (a bare error(404, message) used to drop the code and show a hard-coded Turkish sentence). */
function vaultNotFound(e: unknown): never {
	if (e instanceof AppError) fail(e.code, e.params, 404);
	fail('NOT_FOUND', { entity: 'vault' }, 404);
}

/**
 * Bridge until the /vault/[id]/... routes exist: reads an explicit
 * `?vault=<id>` query param, falls back to the active vault when absent.
 * The original single-vault UI never sends the param (single active-vault workflow) —
 * this only exists so route signatures don't have to change again once
 * the per-vault routes start sending it.
 */
export function vaultFromUrl(url: URL): VaultContext {
	const id = url.searchParams.get('vault');
	try {
		return resolveVault(id);
	} catch (e) {
		vaultNotFound(e);
	}
}

/** Same resolution, for routes that take the vault id from a JSON body
 * field instead of a query param (POST handlers with a request body). */
export function vaultFromId(id?: string | null): VaultContext {
	try {
		return resolveVault(id);
	} catch (e) {
		vaultNotFound(e);
	}
}
