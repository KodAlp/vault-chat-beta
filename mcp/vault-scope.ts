import { resolveVault, type VaultContext } from '../src/lib/server/vaults';
import { closeVaultIndexDb } from '../src/lib/server/retrieve';
import { createMutex } from '../src/lib/server/jobMutex';
import { ToolError } from './errors';

/**
 * Serializes every tool handler through one shared mutex, then closes the
 * vault's index.db handle in a finally — the combination is what makes
 * per-call handle closing safe. Without the serialization, two overlapping
 * tool calls racing to open/close the same vault's handle would produce
 * "The database connection is not open". Without the close, the MCP
 * process would hold SQLite handles between calls and the app's
 * vault-delete route (Faz 8's EBUSY fix target) could fail again — this
 * time because of us, not the app itself. See the mcp-server skill.
 *
 * study.db is never touched here — see the skill's "Üretici araçların
 * erteleme şartları" for why the generator tools (and therefore study.db
 * writes) are out of scope for v1.
 */
const gate = createMutex();

/** The raw serialization primitive — list_vaults uses this directly (it
 * iterates every vault itself, closing each one's handle as it goes,
 * rather than resolving a single vault up front), while withVault below
 * layers vault resolution + handle-close on top for the single-vault tools. */
export function runSerialized<T>(task: () => Promise<T> | T): Promise<T> {
	return gate.run(async () => task());
}

export async function withVault<T>(
	vaultId: string | undefined,
	fn: (v: VaultContext) => Promise<T> | T
): Promise<T> {
	return runSerialized(async () => {
		let v: VaultContext;
		try {
			v = resolveVault(vaultId);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			throw new ToolError('VAULT_NOT_FOUND', message);
		}
		try {
			return await fn(v);
		} finally {
			closeVaultIndexDb(v.id);
		}
	});
}
