import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listVaults, createVault, getActiveVaultId, contextFor, needsMcpMigrationPrompt } from '$lib/server/vaults';
import { countUnindexedFiles } from '$lib/server/retrieve';

/**
 * unindexedCount is computed here, not stored on VaultRecord — that type is
 * vaults.json's own persisted shape (see vaults.ts's readRegistry), and a
 * computed, index-DB-derived count has no business being written back to
 * the registry file. E2 (2026-09-23 report): a curation pass that finished
 * without a following `npm run index` looked, from the app's UI, identical
 * to a vault with nothing new — VaultCard.svelte's own comment called this
 * "out of scope" before this field existed anywhere on the backend.
 */
export const GET: RequestHandler = async () => {
	const vaults = listVaults().map((v) => ({ ...v, unindexedCount: countUnindexedFiles(contextFor(v)) }));
	// İ6: whether the one-time "keep existing vaults open to MCP, or close
	// them?" prompt still needs answering — see vaults.ts's RegistryFile doc
	// comment for why this can't just silently default.
	return json({ vaults, activeVaultId: getActiveVaultId(), needsMcpMigrationPrompt: needsMcpMigrationPrompt() });
};

export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json()) as { name: string };
	if (!body.name?.trim()) error(400, "'name' gerekli");
	try {
		const vault = createVault(body.name);
		return json({ vault });
	} catch (err) {
		error(400, err instanceof Error ? err.message : 'Vault oluşturulamadı');
	}
};
