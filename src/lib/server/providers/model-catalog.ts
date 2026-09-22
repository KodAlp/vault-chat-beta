import fs from 'node:fs';
import path from 'node:path';
import { modelCatalogPath } from '../env';

/**
 * F14-2 — external metadata for filtering the model list (F14-3): which id is deprecated, text-output-only,
 * how old, how large a context window. Two anonymous, keyless public catalogs (real shapes confirmed by
 * fetching both live before writing this):
 *
 *  - OpenRouter `/api/v1/models` (444 models at last check) — used ONLY for the 'openrouter' provider itself,
 *    since its ids ("anthropic/claude-3-opus") are OpenRouter's own and match its own /models response
 *    one-to-one. Fields used: `architecture.output_modalities`, `supported_parameters` (includes "tools" when
 *    tool-calling is supported), `created` (unix seconds), `context_length`. No deprecation flag — OpenRouter
 *    delists models instead of marking them; `expiration_date` (seen on 21/444) means "this free-tier preview
 *    goes away on this date", not "already old", so it is deliberately NOT read as deprecated.
 *  - models.dev `/api.json` (223 provider keys) — one JSON keyed by provider, used for every OTHER configured
 *    provider (groq/google-ai-studio/deepseek-api/mistral/anthropic — see PROVIDER_TO_CATALOG_KEY). Fields:
 *    `modalities.output`, `tool_call` (boolean), `status` ('deprecated' | 'beta' | absent-for-stable),
 *    `release_date` (ISO date), `limit.context`.
 *
 * Never throws, never blocks the app on an external outage: each fetch has its own timeout and try/catch: a
 * failure degrades to an empty catalog for that source (model-filter.ts then just can't classify those ids —
 * they fall into "other", never crash). No API key is ever sent to either endpoint. Disk-cached with a TTL so
 * normal use never waits on these fetches; a fetch failure falls back to the last successful cache rather than
 * going empty, so a transient outage doesn't suddenly hide every cloud model behind "other".
 */

export interface CatalogEntry {
	textOutput: boolean;
	toolCall: boolean;
	deprecated: boolean;
	/** Unix seconds, or null when neither source gave one. */
	releaseDate: number | null;
	contextLength: number | null;
}

/** This app's provider id (config-store.ts) -> the models.dev top-level key. Only the providers this app
 * actually ships need an entry; an unlisted provider id just gets an empty models.dev map (falls into
 * "other" for every model, same as a catalog-fetch failure — never an error). */
export const PROVIDER_TO_CATALOG_KEY: Record<string, string> = {
	groq: 'groq',
	'google-ai-studio': 'google',
	'deepseek-api': 'deepseek',
	mistral: 'mistral',
	anthropic: 'anthropic'
};

/** Per-provider quirks in how a LIVE listModels() id needs to be rewritten before it can be looked up in the
 * models.dev catalog. Confirmed case: Google's OpenAI-compat bridge (v1beta/openai) returns ids prefixed
 * "models/" (e.g. "models/gemini-2.5-flash"), but models.dev's google entries are unprefixed. */
const ID_NORMALIZERS: Record<string, (id: string) => string> = {
	'google-ai-studio': (id) => id.replace(/^models\//, '')
};

export function normalizeModelId(providerId: string, id: string): string {
	return (ID_NORMALIZERS[providerId] ?? ((x: string) => x))(id);
}

export type Fetcher = typeof fetch;

interface OpenRouterModel {
	id: string;
	created?: number;
	context_length?: number;
	architecture?: { output_modalities?: string[] };
	supported_parameters?: string[];
}

interface ModelsDevModel {
	modalities?: { output?: string[] };
	tool_call?: boolean;
	status?: string;
	release_date?: string;
	limit?: { context?: number };
}

const FETCH_TIMEOUT_MS = 10000;

async function fetchOpenRouterCatalog(fetchImpl: Fetcher): Promise<Map<string, CatalogEntry>> {
	const out = new Map<string, CatalogEntry>();
	try {
		const res = await fetchImpl('https://openrouter.ai/api/v1/models', { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
		if (!res.ok) return out;
		const body = (await res.json()) as { data?: OpenRouterModel[] };
		for (const m of body.data ?? []) {
			out.set(m.id, {
				textOutput: m.architecture?.output_modalities?.includes('text') ?? true,
				toolCall: m.supported_parameters?.includes('tools') ?? false,
				deprecated: false,
				releaseDate: typeof m.created === 'number' ? m.created : null,
				contextLength: typeof m.context_length === 'number' ? m.context_length : null
			});
		}
	} catch {
		// stays empty — see module doc comment
	}
	return out;
}

async function fetchModelsDevCatalog(fetchImpl: Fetcher): Promise<Map<string, Map<string, CatalogEntry>>> {
	const out = new Map<string, Map<string, CatalogEntry>>();
	try {
		const res = await fetchImpl('https://models.dev/api.json', { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
		if (!res.ok) return out;
		const body = (await res.json()) as Record<string, { models?: Record<string, ModelsDevModel> }>;
		for (const [providerKey, provider] of Object.entries(body)) {
			const models = new Map<string, CatalogEntry>();
			for (const [modelId, m] of Object.entries(provider.models ?? {})) {
				models.set(modelId, {
					textOutput: m.modalities?.output?.includes('text') ?? true,
					toolCall: m.tool_call === true,
					deprecated: m.status === 'deprecated',
					releaseDate: m.release_date ? Math.floor(Date.parse(m.release_date) / 1000) : null,
					contextLength: typeof m.limit?.context === 'number' ? m.limit.context : null
				});
			}
			out.set(providerKey, models);
		}
	} catch {
		// stays empty — see module doc comment
	}
	return out;
}

export interface Catalog {
	openrouter: Map<string, CatalogEntry>;
	modelsDev: Map<string, Map<string, CatalogEntry>>;
	fetchedAt: string;
}

/** Looks up the catalog entry for a live model id from a given provider — resolves whether to use the
 * OpenRouter map or a models.dev provider map, and applies the id normalizer. Returns undefined (not in
 * either catalog) rather than throwing; the caller (model-filter.ts) treats that as "other", not an error. */
export function lookupCatalogEntry(catalog: Catalog, providerId: string, modelId: string): CatalogEntry | undefined {
	if (providerId === 'openrouter') return catalog.openrouter.get(modelId);
	const key = PROVIDER_TO_CATALOG_KEY[providerId];
	if (!key) return undefined;
	return catalog.modelsDev.get(key)?.get(normalizeModelId(providerId, modelId));
}

const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;

interface CachedCatalogFile {
	fetchedAt: string;
	openrouter: Record<string, CatalogEntry>;
	modelsDev: Record<string, Record<string, CatalogEntry>>;
}

function toCache(catalog: Catalog): CachedCatalogFile {
	return {
		fetchedAt: catalog.fetchedAt,
		openrouter: Object.fromEntries(catalog.openrouter),
		modelsDev: Object.fromEntries([...catalog.modelsDev].map(([k, v]) => [k, Object.fromEntries(v)]))
	};
}

function fromCache(cached: CachedCatalogFile): Catalog {
	return {
		fetchedAt: cached.fetchedAt,
		openrouter: new Map(Object.entries(cached.openrouter ?? {})),
		modelsDev: new Map(Object.entries(cached.modelsDev ?? {}).map(([k, v]) => [k, new Map(Object.entries(v))]))
	};
}

function readCacheFile(): CachedCatalogFile | null {
	try {
		return JSON.parse(fs.readFileSync(modelCatalogPath(), 'utf-8')) as CachedCatalogFile;
	} catch {
		return null;
	}
}

/** A cache file is not durable user data — on a Windows rename hiccup this just skips caching this round and
 * re-fetches next time, so a single writeFileSync+renameSync (no retry loop) is enough, unlike vaults.json's
 * writer. */
function writeCacheFile(cached: CachedCatalogFile): void {
	try {
		const p = modelCatalogPath();
		const tmp = `${p}.${process.pid}.tmp`;
		fs.mkdirSync(path.dirname(p), { recursive: true });
		fs.writeFileSync(tmp, JSON.stringify(cached), 'utf-8');
		fs.renameSync(tmp, p);
	} catch {
		// best-effort — see doc comment
	}
}

/**
 * The catalog to filter against, right now. Disk-cached (TTL, see CATALOG_TTL_MS): a fresh cache is returned
 * without any network call. An expired or missing cache triggers both fetches in parallel; on success the new
 * result is cached and returned. On total fetch failure, an existing (now-stale) cache is still returned in
 * preference to an empty one — a transient outage should not suddenly hide every cloud model. `fetchImpl` is
 * injectable so tests never hit the real network (see model-catalog.test.ts).
 */
export async function loadCatalog(fetchImpl: Fetcher = fetch, now: Date = new Date()): Promise<Catalog> {
	const cached = readCacheFile();
	if (cached && now.getTime() - Date.parse(cached.fetchedAt) < CATALOG_TTL_MS) {
		return fromCache(cached);
	}

	const [openrouter, modelsDev] = await Promise.all([fetchOpenRouterCatalog(fetchImpl), fetchModelsDevCatalog(fetchImpl)]);
	if (openrouter.size === 0 && modelsDev.size === 0) {
		// Both fetches failed (or returned nothing) — prefer a stale cache over an empty catalog.
		if (cached) return fromCache(cached);
		return { openrouter, modelsDev, fetchedAt: now.toISOString() };
	}

	const fresh: Catalog = { openrouter, modelsDev, fetchedAt: now.toISOString() };
	writeCacheFile(toCache(fresh));
	return fresh;
}
