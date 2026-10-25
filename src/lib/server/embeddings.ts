import { ollamaGate } from './providers/ollama-gate';
import { embed as ollamaEmbed, releaseCpuOnlyEmbedRunner } from './ollama';
import { EMBED_MODEL, EMBED_DIMS } from './embed-config';
import { getEmbeddingConfig, isCloud, readProvidersFile, type EmbeddingConfig, type ProviderConfigEntry } from './providers/config-store';
import { secretStore } from './providers/secrets';
import { isProviderConsented } from './provider-consent';
import { AppError } from './app-error';

/**
 * The ONE place that turns text into
 * vectors for this app, resolving whichever provider/model is currently
 * configured (providers/config-store.ts's embedding block) instead of the
 * hardcoded ollama/bge-m3 pair embed-config.ts used to be the only source
 * of truth for. Every caller that used to import `embed` from `./ollama`
 * directly (retrieve.ts, incrementalIndex.ts, smalltalk-runtime.ts, the CLI
 * indexer) now calls `embedTexts()` here instead.
 *
 * Deliberately free of any `$env/dynamic/private` import — this module (like
 * config-store.ts, secrets.ts, provider-consent.ts and env.ts underneath it)
 * must also work from the MCP server (mcp/), which runs under plain `tsx`
 * outside SvelteKit's Vite runtime and cannot resolve that virtual module.
 * See the mcp-server skill.
 *
 * DOC_PREFIX/QUERY_PREFIX (embed-config.ts) are NOT applied here — they stay
 * the caller's responsibility, same as before this module existed. Both are
 * '' for bge-m3 today (a no-op), and prefixing is a property of the specific
 * embedding MODEL in use, not of this dispatch layer; a future model that
 * does want a prefix would need its own per-model table here, which is out
 * of scope for embedding-provider independence.
 */

const BATCH_SIZE = 32;

export interface EmbedTextsOptions {
	/** 'query' asks the Ollama path to run CPU-only (num_gpu: 0) — see
	 * ollama.ts's embed() doc comment for why that matters on a small GPU.
	 * 'document' (bulk indexing) keeps using the GPU for throughput. Ignored
	 * for openai-compat providers, which have no such knob. */
	purpose: 'query' | 'document';
}

function stripTrailingSlash(url: string): string {
	return url.trim().replace(/\/+$/, '');
}

function toEmbeddingUnavailable(providerId: string, err: unknown): AppError {
	const detail = err instanceof Error ? err.message : String(err);
	return new AppError('EMBEDDING_UNAVAILABLE', { provider: providerId, detail });
}

/** Ollama path — reuses ollama.ts's embed() (the same ollamaGate-routed
 * /api/embed call this app has always made) rather than re-implementing it;
 * that function is generic over `model` already, so this is purely dispatch,
 * not a second HTTP client. Network/HTTP failures there surface as a plain
 * Error, which is remapped to the coded EMBEDDING_UNAVAILABLE here so every
 * caller of embedTexts() sees the same error taxonomy regardless of which
 * provider kind actually failed. */
async function embedViaOllama(texts: string[], model: string, cpuOnly: boolean, baseUrl: string): Promise<number[][]> {
	try {
		return await ollamaEmbed(texts, model, { cpuOnly, baseUrl });
	} catch (err) {
		throw toEmbeddingUnavailable('ollama', err);
	}
}

/** openai-compat path (local or cloud) — POST {baseUrl}/embeddings, the
 * standard OpenAI embeddings shape every such provider (and LM Studio/
 * llama.cpp/vLLM's own /v1 surface) accepts. Not routed through
 * providers/openai-compat.ts's OpenAICompatAdapter: that class exists for
 * streaming chat completions (SSE parsing, reasoning normalization, tool
 * calls) — none of which applies to a single non-streaming embeddings POST,
 * so reusing it would mean fighting its chat-shaped machinery for no benefit. */
async function embedViaOpenAICompat(texts: string[], entry: ProviderConfigEntry, model: string): Promise<number[][]> {
	const apiKey = await secretStore.get(entry.id);
	const headers: Record<string, string> = { 'content-type': 'application/json' };
	if (apiKey) headers.authorization = `Bearer ${apiKey}`;

	let res: Response;
	try {
		res = await fetch(`${stripTrailingSlash(entry.baseUrl)}/embeddings`, {
			method: 'POST',
			headers,
			body: JSON.stringify({ model, input: texts })
		});
	} catch (err) {
		throw toEmbeddingUnavailable(entry.id, err);
	}
	if (!res.ok) {
		const bodyText = await res.text().catch(() => '');
		throw new AppError('EMBEDDING_UNAVAILABLE', { provider: entry.id, detail: `HTTP ${res.status} — ${bodyText.slice(0, 300)}` });
	}
	const body = (await res.json()) as { data?: { embedding: number[]; index?: number }[] };
	if (!body.data) throw new AppError('EMBEDDING_UNAVAILABLE', { provider: entry.id, detail: 'yanıtta data alanı yok' });
	// Most OpenAI-compatible servers return `data` already sorted by `index`,
	// but nothing guarantees it — sorting defensively costs nothing and avoids
	// silently pairing the wrong vector with the wrong input text.
	return [...body.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((d) => d.embedding);
}

function resolveProviderEntry(providerId: string): ProviderConfigEntry {
	const entry = readProvidersFile().providers.find((p) => p.id === providerId);
	if (!entry) throw new AppError('NOT_FOUND', { entity: 'provider', detail: providerId }, 404);
	return entry;
}

function assertConsented(entry: ProviderConfigEntry): void {
	if (isCloud(entry) && !isProviderConsented(entry.id)) {
		throw new AppError('EMBEDDING_CONSENT_REQUIRED', { provider: entry.id });
	}
}

async function embedBatch(
	texts: string[],
	entry: ProviderConfigEntry,
	model: string,
	opts: EmbedTextsOptions
): Promise<number[][]> {
	if (entry.kind === 'ollama') return embedViaOllama(texts, model, opts.purpose === 'query', entry.baseUrl);
	if (entry.kind === 'openai-compat') return embedViaOpenAICompat(texts, entry, model);
	// config-store.ts's setEmbeddingConfig() already rejects any other kind at
	// save time — reaching here means providers.json was edited by hand (or
	// predates that validation), so this is a real, if unlikely, runtime state.
	throw new AppError('EMBEDDING_PROVIDER_KIND_UNSUPPORTED', { provider: entry.id });
}

/**
 * Turns `texts` into vectors using the currently configured embedding
 * provider/model (getEmbeddingConfig()). Batches in groups of 32 regardless
 * of `purpose` — a single query is one text and batching it is a no-op, so
 * there is no reason for two code paths.
 *
 * Throws (never returns a partial/wrong-length result):
 *  - EMBEDDING_NOT_CONFIGURED — FTS-only mode (getEmbeddingConfig() is null);
 *    callers that can run without vectors check the config first instead.
 *  - NOT_FOUND — the configured provider id no longer exists in providers.json.
 *  - EMBEDDING_CONSENT_REQUIRED — the configured provider is a non-local
 *    cloud provider with no recorded consent (provider-consent.ts).
 *  - EMBEDDING_UNAVAILABLE — a network/HTTP failure reaching the provider.
 *  - EMBEDDING_DIMS_MISMATCH — a returned vector's length doesn't match the
 *    configured `dims` (the provider silently started serving a different
 *    model, or `dims` was misconfigured).
 */
export async function embedTexts(texts: string[], opts: EmbedTextsOptions): Promise<number[][]> {
	if (texts.length === 0) return [];
	const config = getEmbeddingConfig();
	if (!config) throw new AppError('EMBEDDING_NOT_CONFIGURED');
	const entry = resolveProviderEntry(config.providerId);
	assertConsented(entry);

	// Once per call (not per batch): see releaseCpuOnlyEmbedRunner.
	if (opts.purpose === 'document' && entry.kind === 'ollama') {
		await releaseCpuOnlyEmbedRunner(config.model, entry.baseUrl);
	}

	const results: number[][] = [];
	for (let i = 0; i < texts.length; i += BATCH_SIZE) {
		const batch = texts.slice(i, i + BATCH_SIZE);
		const vectors = await embedBatch(batch, entry, config.model, opts);
		for (const v of vectors) {
			if (v.length !== config.dims) {
				throw new AppError('EMBEDDING_DIMS_MISMATCH', {
					provider: entry.id,
					detail: `${v.length} != ${config.dims}`
				});
			}
		}
		results.push(...vectors);
	}
	return results;
}

/**
 * One embed call against an ARBITRARY provider/model pair — not necessarily
 * the currently configured one — purely to measure its output dimension.
 * Meant for the future settings UI's "Test" button (POST /api/embedding/test):
 * the user picks a provider/model before committing dims to config, and this
 * is how those dims get filled in instead of guessed. Applies the same
 * consent/kind checks embedTexts() does, but never touches getEmbeddingConfig()
 * or the saved config at all.
 */
export async function measureEmbeddingDims(providerId: string, model: string): Promise<number> {
	const entry = resolveProviderEntry(providerId);
	assertConsented(entry);
	const [vector] =
		entry.kind === 'ollama'
			? await embedViaOllama(['test'], model, true, entry.baseUrl)
			: entry.kind === 'openai-compat'
				? await embedViaOpenAICompat(['test'], entry, model)
				: (() => {
						throw new AppError('EMBEDDING_PROVIDER_KIND_UNSUPPORTED', { provider: providerId });
					})();
	return vector.length;
}

/**
 * The key smalltalk-store.ts's `embed_model` column is written/read under —
 * NOT simply `${providerId}/${model}/${dims}` for the default config, so an
 * install upgrading into embedding-provider independence keeps its existing learned phrases (rows
 * written under the literal string 'bge-m3', embed-config.ts's old
 * EMBED_MODEL constant) usable instead of orphaning them and paying a
 * one-time re-embed for no config change at all. Any OTHER config (a real
 * provider/model change) gets the full identity string, so a genuine switch
 * still correctly invalidates the old rows (smalltalk-store.ts's
 * isReady/ensureReady already re-embed on a key mismatch — that path is
 * exactly what should fire for an actual change, just not for "nothing
 * changed since before this feature existed").
 */
export function embeddingKey(explicit?: EmbeddingConfig): string {
	const config = explicit ?? getEmbeddingConfig();
	if (!config) throw new AppError('EMBEDDING_NOT_CONFIGURED');
	const isLegacyDefault = config.providerId === 'ollama' && config.model === EMBED_MODEL && config.dims === EMBED_DIMS;
	return isLegacyDefault ? EMBED_MODEL : `${config.providerId}/${config.model}/${config.dims}`;
}
