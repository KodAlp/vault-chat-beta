/**
 * Aşama 3a (embedding-bagimsizligi) — codes for the provider-agnostic
 * embedding layer: src/lib/server/embeddings.ts (the single embed path),
 * providers/config-store.ts's embedding-config accessors, indexer/db.ts's
 * index_meta table, and retrieve.ts's mismatch/fallback handling.
 *
 * Deliberately one code per distinct failure rather than a shared code with
 * a `reason` param — matches this catalog's existing PROVIDER_OLLAMA_*
 * granularity (see error-codes/settings.ts), and each of these needs its own
 * sentence, not a templated one.
 */
export const EMBEDDING_CODES = [
	// setEmbeddingConfig()/PUT /api/embedding validation — the chosen provider
	// can't actually serve embeddings (wrong enabled/kind state).
	'EMBEDDING_PROVIDER_DISABLED',
	'EMBEDDING_PROVIDER_KIND_UNSUPPORTED',
	// setEmbeddingConfig() validation — dims must be a positive integer.
	'EMBEDDING_DIMS_INVALID',
	// setEmbeddingConfig()/embedTexts() — a non-local cloud provider with no
	// prior "remember my choice" (provider-consent.ts).
	'EMBEDDING_CONSENT_REQUIRED',
	// embedTexts() — the provider returned a vector whose length doesn't match
	// the configured dims (a model swap the user didn't tell this config about).
	'EMBEDDING_DIMS_MISMATCH',
	// embedTexts() — network/HTTP failure reaching the configured provider.
	'EMBEDDING_UNAVAILABLE',
	// Aşama 4a — no embedding provider configured (FTS-only mode): thrown by
	// embedTexts()/embeddingKey() when called with no config. Retrieval and the
	// generators do NOT raise it: they run on keyword search in FTS-only mode.
	'EMBEDDING_NOT_CONFIGURED',
	// retrieve()/incrementalIndex.ts — the index's recorded embedding
	// (index_meta, or the legacy bge-m3/1024 assumption) differs from the
	// current config: vectors would not be comparable, so vector search is
	// skipped (retrieve) or the write is refused (incrementalIndex) rather
	// than silently corrupting the index.
	'EMBEDDING_MISMATCH',

	// Aşama 3b — reindex.ts / POST /api/vaults/[id]/reindex.
	// A second reindex (or an incremental write — incrementalIndex.ts checks
	// the same lock) was attempted for a vault that's already being rebuilt.
	'REINDEX_IN_PROGRESS',
	// The rebuild finished, but swapIndexIntoPlace() could not rename the new
	// index over the old one after retrying — almost always another process
	// (the MCP server) still has index.db open. The OLD index is guaranteed
	// intact; the freshly built one was discarded and must be rebuilt.
	'REINDEX_INDEX_LOCKED',

	// Chat reranker (reranker.ts, /api/settings/reranker): turning it on before the model is in the cache,
	// and a failed model download.
	'RERANKER_MODEL_MISSING',
	'RERANKER_DOWNLOAD_FAILED'
] as const;
