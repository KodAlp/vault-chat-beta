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
	// retrieve()/incrementalIndex.ts — the index's recorded embedding
	// (index_meta, or the legacy bge-m3/1024 assumption) differs from the
	// current config: vectors would not be comparable, so vector search is
	// skipped (retrieve) or the write is refused (incrementalIndex) rather
	// than silently corrupting the index.
	'EMBEDDING_MISMATCH'
] as const;
