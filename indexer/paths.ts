import { resolveVault, type VaultContext } from '../src/lib/server/vaults';

/**
 * `--vault <id>` on the CLI, falling back to the registry's active vault
 * when omitted — same resolution vaultFromUrl/vaultFromId use on the
 * SvelteKit side (src/lib/server/requestVault.ts). See vault-registry skill.
 */
function vaultIdFromArgs(argv: string[]): string | undefined {
	const i = argv.indexOf('--vault');
	return i !== -1 ? argv[i + 1] : undefined;
}

export function resolveIndexerVault(argv: string[]): VaultContext {
	return resolveVault(vaultIdFromArgs(argv));
}
