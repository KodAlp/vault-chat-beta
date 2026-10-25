import { resolveVault, isVaultMcpExposed, listVaults, type VaultContext } from '../src/lib/server/vaults';
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
 * vault-delete route (the EBUSY fix target) could fail again — this
 * time because of us, not the app itself.
 *
 * study.db is never touched here: the generator tools (and therefore study.db
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

function fold(s: string): string[] {
	const t = s.trim();
	return [t.toLowerCase(), t.toLocaleLowerCase('tr-TR')];
}

/**
 * Yerel modeller (#39, 2026-10-16, qwen3 8B) kasayı çoğu zaman list_vaults'a
 * bakmadan adıyla ("Fizik") verir, hata alınca da list_vaults'a dönmek yerine
 * pes eder. Yalnız DIŞA AÇIK kasalar arasında büyük/küçük harf duyarsız kimlik
 * ya da ad tek bir kasaya çıkıyorsa onun kimliği kullanılır. Kapalı kasalar
 * eşleşmeye hiç girmez (`mcpExposed` kapısı aynı), birden çok eşleşme belirsizdir.
 */
export function normalizeVaultArg(arg: string | undefined): string | undefined {
	if (arg === undefined) return undefined;
	const exposed = listVaults().filter((v) => v.mcpExposed === true);
	if (exposed.some((v) => v.id === arg)) return arg;
	const keys = new Set(fold(arg));
	const hits = exposed.filter((v) => [...fold(v.id), ...fold(v.name)].some((k) => keys.has(k)));
	return hits.length === 1 ? hits[0].id : arg;
}

/** Hata mesajına eklenen ipucu: dışa açık kasalar (list_vaults'un zaten gösterdiği). */
function exposedHint(): string {
	const exposed = listVaults().filter((v) => v.mcpExposed === true);
	if (exposed.length === 0) return ' Dış istemcilere açık kasa yok.';
	return ` Erişilebilir kasalar (kimlik — ad): ${exposed.map((v) => `${v.id} — ${v.name}`).join(', ')}.`;
}

export async function withVault<T>(
	vaultArg: string | undefined,
	fn: (v: VaultContext) => Promise<T> | T
): Promise<T> {
	return runSerialized(async () => {
		const vaultId = normalizeVaultArg(vaultArg);
		let v: VaultContext;
		try {
			v = resolveVault(vaultId);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			throw new ToolError('VAULT_NOT_FOUND', message + exposedHint());
		}
		// Closed by default — an unset vaultId resolves to the
		// active vault, which itself may be closed, so this rejects that path
		// too rather than only ever gating an explicit id. A client that
		// already knows or guesses an id (e.g. "default") gets the same
		// rejection a client that never saw it in list_vaults would.
		if (!isVaultMcpExposed(v.id)) {
			throw new ToolError(
				'VAULT_NOT_EXPOSED',
				`Bu kasa dış istemcilere açık değil: ${v.id}. Ayarlar → Kasalar'dan açabilirsin.` + exposedHint()
			);
		}
		try {
			return await fn(v);
		} finally {
			closeVaultIndexDb(v.id);
		}
	});
}
