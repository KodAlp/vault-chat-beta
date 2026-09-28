import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listVaults, createVault, getActiveVaultId, contextFor, needsMcpMigrationPrompt } from '$lib/server/vaults';
import { countUnindexedFiles, checkEmbeddingMismatch } from '$lib/server/retrieve';
import { AppError, fail, toCodedError } from '$lib/server/app-error';
import type { ErrorCode } from '$lib/errors';
import type { VaultWithStatus } from '$lib/types';

/**
 * unindexedCount is computed here, not stored on VaultRecord — that type is
 * vaults.json's own persisted shape (see vaults.ts's readRegistry), and a
 * computed, index-DB-derived count has no business being written back to
 * the registry file. E2 (2026-09-23 report): a curation pass that finished
 * without a following `npm run index` looked, from the app's UI, identical
 * to a vault with nothing new — VaultCard.svelte's own comment called this
 * "out of scope" before this field existed anywhere on the backend.
 *
 * Aşama 3c — `embeddingMismatch` is the same kind of computed, non-persisted
 * status: whether this vault's index was built under a different embedding
 * than what's currently configured (checkEmbeddingMismatch, retrieve.ts).
 * `embeddingMismatchDetail` is only attached when true, so the common case
 * costs nothing extra on the wire.
 */
export const GET: RequestHandler = async () => {
	const vaults: VaultWithStatus[] = listVaults().map((v) => {
		const ctx = contextFor(v);
		const embedding = checkEmbeddingMismatch(ctx);
		return {
			...v,
			unindexedCount: countUnindexedFiles(ctx),
			embeddingMismatch: embedding.mismatch,
			...(embedding.mismatch && embedding.index
				? {
						embeddingMismatchDetail: {
							indexProvider: embedding.index.provider,
							indexModel: embedding.index.model,
							indexDims: embedding.index.dims,
							configProvider: embedding.config.provider,
							configModel: embedding.config.model,
							configDims: embedding.config.dims
						}
					}
				: {})
		};
	});
	// İ6: whether the one-time "keep existing vaults open to MCP, or close
	// them?" prompt still needs answering — see vaults.ts's RegistryFile doc
	// comment for why this can't just silently default.
	return json({ vaults, activeVaultId: getActiveVaultId(), needsMcpMigrationPrompt: needsMcpMigrationPrompt() });
};

export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json()) as { name: string };
	if (!body.name?.trim()) fail('VALIDATION_REQUIRED', { field: "'name'" });
	try {
		const vault = createVault(body.name);
		return json({ vault });
	} catch (err) {
		if (err instanceof AppError) fail(err.code, err.params, err.status);
		const coded = toCodedError(err);
		fail(coded.code as ErrorCode, coded.params, 400);
	}
};
