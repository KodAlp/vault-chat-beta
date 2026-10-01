import fs from 'node:fs';
import { providersPath } from '../env';
import { AppError } from '../app-error';
import { EMBED_MODEL, EMBED_DIMS } from '../embed-config';
import { isProviderConsented } from '../provider-consent';
import type { ModelCapsOverride } from './model-caps';

/**
 * F14-4 — providers.json is now written more often (a checkbox toggle in the model-management UI writes on
 * every click, same "instant PATCH" pattern as the rest of this settings page), so a plain whole-file
 * writeFileSync is more likely to collide with a concurrent read. Same tmp+rename-with-retry shape as
 * vaults.ts's writeRegistry — Windows can transiently EPERM/EBUSY a rename right after a write.
 */
const RENAME_ATTEMPTS = 4;
const RENAME_BACKOFF_MS = 25;

/** Synchronous blocking sleep (Atomics.wait on a throwaway SharedArrayBuffer) — same trick vaults.ts's
 * writeRegistry uses, so this stays a sync function and every existing caller (addProvider, deleteProvider,
 * updateProviderEnabled, ...) keeps its current sync signature. */
function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export interface ProviderConfigEntry {
	id: string;
	label: string;
	baseUrl: string;
	kind: 'ollama' | 'openai-compat' | 'anthropic' | 'azure-openai';
	reasoningDialect: 'think-tags' | 'reasoning_content' | 'none';
	enabled: boolean;
	timeouts: { connectMs: number; firstTokenMs: number; idleMs: number };
	/**
	 * Problem A — a local (or local-network) OpenAI-compatible server: LM Studio, llama.cpp server, vLLM,
	 * LocalAI, Jan, or another machine's Ollama reached through its own /v1 surface. Only meaningful when
	 * `kind === 'openai-compat'` (Ollama is already local by kind; Anthropic/Azure OpenAI are never local).
	 * This is the user's own statement that the server never leaves their machine/network — isCloud() below
	 * reads it to skip the cloud consent dialog and the cloud badge, and the model pickers skip the
	 * OpenRouter/models.dev catalog filter for it (see model-filter.ts's pickerModels), since a small local
	 * server's model ids are never going to be in that catalog. Optional so an existing config keeps working
	 * (see defaultModel's doc comment above for why every new field here must be optional — the Tauri build
	 * only copies providers.json on first launch).
	 */
	local?: boolean;
	/**
	 * Which model THIS provider should be asked for when the fallback chain
	 * reaches it without an explicit choice — a model id is provider-scoped
	 * data, not a universal name. Without it, registry.ts reused the model id
	 * of the provider that just failed for the next one in the chain, which is
	 * how a DeepSeek model id ended up being requested from Ollama
	 * ("model 'deepseek-flash' not found").
	 *
	 * Optional on purpose: the Tauri build copies providers.json into app-data
	 * on FIRST LAUNCH ONLY (src-tauri/src/lib.rs), so an existing install never
	 * receives newly added fields. A provider without it is skipped in the
	 * chain rather than asked for a model known to be wrong.
	 */
	defaultModel?: string;
	/** F14-4 — a manual allow-list of model ids for this provider's pickers. Absent/empty means "show
	 * everything model-filter.ts's approved list already contains" — this field only ever NARROWS that list
	 * further, it never re-adds a model the filter rejected. Set the first time the user unchecks anything in
	 * the settings page's "model listesini yönet" section. */
	enabledModels?: string[];
	/**
	 * Problem B — a manual list of model ids to ADD to this provider's pickers, on top of whatever the
	 * catalog filter + enabledModels narrowing already produce (see model-filter.ts's pickerModels). Exists
	 * for two cases enabledModels can't cover, because it only ever narrows: a model the catalog doesn't
	 * know about yet (very new, or a very small provider) and a model the provider's own /models endpoint
	 * doesn't list at all (e.g. an Azure OpenAI deployment name — Azure's /models surface is not documented
	 * to list deployments). A pinned id that isn't in the provider's live listModels() result gets a
	 * conservative placeholder ({ctx: 8192, caps: {tools:false, reasoning:false}}) rather than being dropped.
	 */
	pinnedModels?: string[];
	/**
	 * Aşama 4b — per-model override of the capability flags model-caps.ts's table would otherwise decide
	 * (tool-calling, reasoning), keyed by the model id exactly as the provider lists it. A flag that is
	 * absent falls through to the table; the override wins flag by flag. Optional for the same reason every
	 * field here is (an existing providers.json never gains new fields on its own).
	 */
	modelCaps?: Record<string, ModelCapsOverride>;
}

/** Cloud providers are every kind except Ollama (always local) and an openai-compat entry the user has
 * marked `local: true` (problem A) — this drives the settings UI's "add provider" form, the cloud badge, and
 * whether the cloud-consent dialog is shown before a model picker switches onto it. Takes the whole entry
 * (or a pick of it) rather than just `kind` now that locality is no longer implied by kind alone. */
export function isCloud(entry: Pick<ProviderConfigEntry, 'kind' | 'local'>): boolean {
	return entry.kind !== 'ollama' && !entry.local;
}

/**
 * Aşama 3a (embedding-bagimsizligi) — which provider/model builds the vault
 * index and embeds queries, now a config choice instead of the hardcoded
 * ollama/bge-m3 pair in embed-config.ts. Absent from providers.json entirely
 * means "never configured" — getEmbeddingConfig() below is the only place
 * that fills in the default (legacy ollama/bge-m3 when an 'ollama' provider
 * entry exists, otherwise null).
 *
 * Aşama 4a — `embedding: null` (explicit in the file, or the resolved result
 * when nothing is configured and there is no ollama entry) is FTS-only mode:
 * no embedding provider at all, the index holds chunks + keyword (FTS5)
 * data only and retrieval is keyword search. Every reader of
 * getEmbeddingConfig() must handle null.
 *
 * `dims` is stored explicitly rather than derived from a model-name lookup
 * table: an openai-compat endpoint's dimension isn't knowable from its model
 * id alone (unlike bge-m3, a cloud embedding model's dimension is a fact
 * about that specific deployment) — measureEmbeddingDims() (embeddings.ts)
 * is how the settings UI is meant to fill this in via one real embed call,
 * not a guess.
 *
 * `distanceThreshold` is optional on purpose: absent means "use
 * select-chunks.ts's own DISTANCE_THRESHOLD constant", which is the value
 * actually measured against bge-m3's real cosine-distance distribution (see
 * that file's doc comment) — a config written before this field existed, or
 * one that never touched it, keeps using exactly that measurement instead of
 * silently adopting some other default that was never verified against this
 * vault's corpus.
 */
export interface EmbeddingConfig {
	providerId: string;
	model: string;
	dims: number;
	distanceThreshold?: number;
}

/** getEmbeddingConfig()'s fallback when providers.json has no `embedding`
 * key at all AND an 'ollama' provider entry exists — the exact pair
 * embed-config.ts hardcoded before this feature existed, so an upgraded
 * install keeps indexing/retrieving identically until the user explicitly
 * changes it in settings. */
const DEFAULT_EMBEDDING_CONFIG: EmbeddingConfig = { providerId: 'ollama', model: EMBED_MODEL, dims: EMBED_DIMS };

/** Where an Ollama provider is assumed to listen when providers.json has no ollama-kind entry at all
 * (nothing to read a baseUrl from). */
export const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434';

/** The configured Ollama provider's baseUrl (the entry with id 'ollama', else the first ollama-kind entry),
 * trailing slashes stripped. Used by ollama-gate.ts's native /api/ps and unload calls, which have no
 * provider entry in hand. Never throws — an unreadable providers.json degrades to the default. */
export function getOllamaBaseUrl(): string {
	try {
		const { providers } = readFile();
		const entry = providers.find((p) => p.id === 'ollama' && p.kind === 'ollama') ?? providers.find((p) => p.kind === 'ollama');
		if (entry?.baseUrl) return entry.baseUrl.trim().replace(/\/+$/, '');
	} catch {
		// fall through to the default
	}
	return DEFAULT_OLLAMA_BASE_URL;
}

/** Provider kinds embeddings.ts actually knows how to call — 'anthropic' and
 * 'azure-openai' have no embeddings adapter in this phase (see the plan's
 * scope note); validating this here, not just in embeddings.ts, means a bad
 * choice is rejected at save time instead of failing every retrieval later. */
const EMBEDDING_CAPABLE_KINDS: ReadonlySet<ProviderConfigEntry['kind']> = new Set(['ollama', 'openai-compat']);

export interface ProvidersFile {
	providers: ProviderConfigEntry[];
	chains: Record<string, string[]>;
	/** Absent = "never configured" (see getEmbeddingConfig); null = explicitly FTS-only. */
	embedding?: EmbeddingConfig | null;
}

function readFile(): ProvidersFile {
	return JSON.parse(fs.readFileSync(providersPath(), 'utf-8')) as ProvidersFile;
}

function writeFile(data: ProvidersFile): void {
	const p = providersPath();
	const tmp = `${p}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf-8');

	for (let attempt = 1; ; attempt++) {
		try {
			fs.renameSync(tmp, p);
			return;
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			const transient = code === 'EPERM' || code === 'EBUSY' || code === 'EACCES';
			if (!transient || attempt === RENAME_ATTEMPTS) {
				try {
					fs.rmSync(tmp, { force: true });
				} catch {
					// Nothing useful to do — do not mask the real failure below.
				}
				throw err;
			}
			sleepSync(RENAME_BACKOFF_MS * attempt);
		}
	}
}

/** Settings-UI writers for data/providers.json — separate from registry.ts's
 * read-only, mtime-cached loader. Writing here naturally invalidates that
 * cache (the mtime changes), so no extra invalidation call is needed. */
export function readProvidersFile(): ProvidersFile {
	return readFile();
}

export function updateProviderEnabled(id: string, enabled: boolean): ProviderConfigEntry {
	const data = readFile();
	const entry = data.providers.find((p) => p.id === id);
	if (!entry) throw new AppError('NOT_FOUND', { entity: 'provider', detail: id }, 404);
	// Ollama is an ordinary provider now (no longer a mandatory one): it may be disabled like any other.
	entry.enabled = enabled;
	writeFile(data);
	return entry;
}

export function updateProviderDefaultModel(id: string, defaultModel: string | null): void {
	const data = readFile();
	const entry = data.providers.find((p) => p.id === id);
	if (!entry) throw new AppError('NOT_FOUND', { entity: 'provider', detail: id }, 404);
	if (defaultModel) entry.defaultModel = defaultModel;
	else delete entry.defaultModel;
	writeFile(data);
}

/** F14-4 — the manual model allow-list (see ProviderConfigEntry.enabledModels's doc comment). An empty array
 * is stored as-is, not deleted: "the user unchecked everything" is a real, distinct state from "never
 * curated" — the settings page can tell them apart to say "hiçbiri seçili değil" instead of silently falling
 * back to the filter's full approved list. `null` clears it back to that uncurated state. */
export function updateEnabledModels(id: string, modelIds: string[] | null): void {
	const data = readFile();
	const entry = data.providers.find((p) => p.id === id);
	if (!entry) throw new AppError('NOT_FOUND', { entity: 'provider', detail: id }, 404);
	if (modelIds === null) delete entry.enabledModels;
	else entry.enabledModels = modelIds;
	writeFile(data);
}

/**
 * Problem B's writer — validates as it stores (unlike updateEnabledModels, which trusts the caller): a
 * non-string, empty/whitespace-only, or absurdly long (>200 chars — well past any real model/deployment id)
 * entry is silently dropped rather than saved, and duplicates are removed while keeping first-seen order.
 * `null` clears the field entirely (mirrors updateEnabledModels' null semantics); an empty array is a valid,
 * intentional "nothing pinned" and is stored as-is, same distinction as enabledModels draws.
 */
export function updatePinnedModels(id: string, modelIds: string[] | null): void {
	const data = readFile();
	const entry = data.providers.find((p) => p.id === id);
	if (!entry) throw new AppError('NOT_FOUND', { entity: 'provider', detail: id }, 404);
	if (modelIds === null) {
		delete entry.pinnedModels;
		writeFile(data);
		return;
	}
	const seen = new Set<string>();
	const cleaned: string[] = [];
	for (const raw of modelIds) {
		if (typeof raw !== 'string') continue;
		const trimmed = raw.trim();
		if (!trimmed || trimmed.length > 200) continue;
		if (seen.has(trimmed)) continue;
		seen.add(trimmed);
		cleaned.push(trimmed);
	}
	entry.pinnedModels = cleaned;
	writeFile(data);
}

/**
 * Aşama 4b — sets (or, with `caps === null`, clears) one model's capability override. Validates as it
 * stores: the model id must be a non-empty string of at most 200 chars, and only boolean `tools` /
 * `reasoning` keys are kept (anything else is dropped); an override left with no flags is removed, and an
 * emptied `modelCaps` map is deleted from the entry, so a cleared state round-trips as "never set".
 */
export function updateModelCaps(id: string, modelId: string, caps: ModelCapsOverride | null): void {
	const data = readFile();
	const entry = data.providers.find((p) => p.id === id);
	if (!entry) throw new AppError('NOT_FOUND', { entity: 'provider', detail: id }, 404);
	const key = typeof modelId === 'string' ? modelId.trim() : '';
	if (!key || key.length > 200) throw new AppError('VALIDATION_INVALID', { field: 'modelId' });
	const clean: ModelCapsOverride = {};
	if (caps && typeof caps.tools === 'boolean') clean.tools = caps.tools;
	if (caps && typeof caps.reasoning === 'boolean') clean.reasoning = caps.reasoning;
	if (Object.keys(clean).length === 0) {
		if (entry.modelCaps) {
			delete entry.modelCaps[key];
			if (Object.keys(entry.modelCaps).length === 0) delete entry.modelCaps;
		}
	} else {
		entry.modelCaps = { ...(entry.modelCaps ?? {}), [key]: clean };
	}
	writeFile(data);
}

/** Problem A — lets the settings page toggle `local` on an EXISTING openai-compat provider (the add-form
 * only sets it at creation time). Silently ignored on any other kind: Ollama is already local by kind,
 * Anthropic/Azure OpenAI are never local, so there is no state for this to change there. */
export function updateProviderLocal(id: string, local: boolean): void {
	const data = readFile();
	const entry = data.providers.find((p) => p.id === id);
	if (!entry) throw new AppError('NOT_FOUND', { entity: 'provider', detail: id }, 404);
	if (entry.kind !== 'openai-compat') return;
	if (local) entry.local = true;
	else delete entry.local;
	writeFile(data);
}

/**
 * Validates before writing (Aşama 4c — the first-run wizard now writes chains over HTTP): the task type must
 * be a non-empty string, every id a string naming a provider that exists, and an id may appear only once.
 * An empty list is valid (a task with no provider — chatWithFallback then reports CHAT_NO_CHAIN).
 */
export function updateChain(taskType: string, providerIds: string[]): void {
	if (typeof taskType !== 'string' || !taskType.trim()) throw new AppError('VALIDATION_INVALID', { field: 'taskType' });
	if (!Array.isArray(providerIds) || providerIds.some((id) => typeof id !== 'string')) {
		throw new AppError('VALIDATION_INVALID', { field: 'providerIds' });
	}
	const data = readFile();
	for (const id of providerIds) {
		if (!data.providers.some((p) => p.id === id)) throw new AppError('NOT_FOUND', { entity: 'provider', detail: id }, 404);
	}
	if (new Set(providerIds).size !== providerIds.length) throw new AppError('VALIDATION_INVALID', { field: 'providerIds' });
	data.chains[taskType] = providerIds;
	writeFile(data);
}

function resolveEmbeddingConfig(data: ProvidersFile): EmbeddingConfig | null {
	if (data.embedding === null) return null;
	if (data.embedding) return data.embedding;
	return data.providers.some((p) => p.id === 'ollama') ? DEFAULT_EMBEDDING_CONFIG : null;
}

/** The embedding config in effect right now: the explicit `embedding` block
 * if there is one, else DEFAULT_EMBEDDING_CONFIG when an 'ollama' entry
 * exists (legacy installs), else null = FTS-only mode. Every caller
 * (embeddings.ts, retrieve.ts, incrementalIndex.ts, the CLI indexer,
 * ollama-gate.ts's resident-model set) reads through this rather than
 * checking for the field's presence itself, and must handle null. */
export function getEmbeddingConfig(): EmbeddingConfig | null {
	return resolveEmbeddingConfig(readFile());
}

/**
 * Validates before writing, unlike updateEnabledModels/updatePinnedModels
 * (which trust the settings UI's own input restrictions) — a bad embedding
 * config doesn't just look wrong in a list, it silently breaks every future
 * retrieval/index write (see EMBEDDING_MISMATCH in retrieve.ts/
 * incrementalIndex.ts), so rejecting it at save time is the only point where
 * a clear, coded reason is still cheap to give.
 *
 * Consent is checked here too (not just embeddings.ts's runtime path,
 * per-call) so the settings UI gets an immediate, specific
 * EMBEDDING_CONSENT_REQUIRED at save time instead of the config silently
 * saving and only failing on the next chat message.
 */
export function setEmbeddingConfig(cfg: EmbeddingConfig | null): void {
	const data = readFile();
	if (cfg === null) {
		// Explicit FTS-only mode — stored as null (not deleted) so the legacy ollama default does not come back.
		data.embedding = null;
		writeFile(data);
		return;
	}
	const entry = data.providers.find((p) => p.id === cfg.providerId);
	if (!entry) throw new AppError('NOT_FOUND', { entity: 'provider', detail: cfg.providerId }, 404);
	if (!entry.enabled) throw new AppError('EMBEDDING_PROVIDER_DISABLED', { provider: cfg.providerId });
	if (!EMBEDDING_CAPABLE_KINDS.has(entry.kind)) {
		throw new AppError('EMBEDDING_PROVIDER_KIND_UNSUPPORTED', { provider: cfg.providerId });
	}
	if (!cfg.model || !cfg.model.trim()) throw new AppError('VALIDATION_REQUIRED', { field: 'model' });
	if (!Number.isInteger(cfg.dims) || cfg.dims <= 0) {
		throw new AppError('EMBEDDING_DIMS_INVALID', { detail: String(cfg.dims) });
	}
	if (cfg.distanceThreshold !== undefined && (!Number.isFinite(cfg.distanceThreshold) || cfg.distanceThreshold <= 0)) {
		throw new AppError('VALIDATION_INVALID', { field: 'distanceThreshold' });
	}
	if (isCloud(entry) && !isProviderConsented(cfg.providerId)) {
		throw new AppError('EMBEDDING_CONSENT_REQUIRED', { provider: cfg.providerId });
	}
	data.embedding = {
		providerId: cfg.providerId,
		model: cfg.model.trim(),
		dims: cfg.dims,
		...(cfg.distanceThreshold !== undefined ? { distanceThreshold: cfg.distanceThreshold } : {})
	};
	writeFile(data);
}

function slugify(s: string): string {
	return s
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
}

export interface NewProviderInput {
	label: string;
	baseUrl: string;
	kind: 'openai-compat' | 'anthropic' | 'azure-openai';
	reasoningDialect: 'think-tags' | 'reasoning_content' | 'none';
	/** Problem A — only honored when `kind === 'openai-compat'`; see ProviderConfigEntry.local's doc comment. */
	local?: boolean;
}

/**
 * Trims and strips trailing slash(es) so openai-compat.ts's
 * `${baseUrl}/chat/completions` never ends up as a double-slash `//chat/
 * completions` (a 404 on most OpenAI-compatible APIs) just because the user
 * pasted a base URL with a trailing `/`. Throws on anything that isn't
 * `http://`/`https://` — a provider entry with no real scheme would never
 * successfully connect anyway, and failing at save time (with a specific
 * reason) beats failing silently at chat time.
 */
export function normalizeBaseUrl(raw: string): string {
	const trimmed = raw.trim().replace(/\/+$/, '');
	if (!/^https?:\/\//i.test(trimmed)) {
		throw new AppError('PROVIDER_BASE_URL_INVALID', { url: raw.trim() });
	}
	return trimmed;
}

/** Faz 16A — adds an OpenAI-compatible (or native Anthropic, 16B) provider
 * with a generated id derived from the label, default cloud timeouts, and
 * the provider NOT enabled until the user flips it on (a provider with no
 * API key yet must not silently become the chat default). */
export function addProvider(input: NewProviderInput): ProviderConfigEntry {
	const data = readFile();
	const base = slugify(input.label) || 'provider';
	let id = base;
	let n = 2;
	while (data.providers.some((p) => p.id === id)) {
		id = `${base}-${n++}`;
	}
	// Problem A — a local server gets the same generous timeouts as the ollama entry (see data/providers.json):
	// a cold-loading LM Studio/llama.cpp/vLLM instance on this machine or the local network can take just as
	// long to serve its first token as a locally-loaded Ollama model, and a 5s connect / 30s first-token cloud
	// timeout would abort it long before it ever gets there.
	const local = input.kind === 'openai-compat' && input.local === true;
	const entry: ProviderConfigEntry = {
		id,
		label: input.label.trim(),
		baseUrl: normalizeBaseUrl(input.baseUrl),
		kind: input.kind,
		reasoningDialect: input.reasoningDialect,
		enabled: false,
		timeouts: local
			? { connectMs: 30000, firstTokenMs: 300000, idleMs: 60000 }
			: { connectMs: 5000, firstTokenMs: 30000, idleMs: 30000 },
		...(local ? { local: true } : {})
	};
	data.providers.push(entry);
	writeFile(data);
	return entry;
}

export function deleteProvider(id: string): void {
	const data = readFile();
	const idx = data.providers.findIndex((p) => p.id === id);
	if (idx === -1) throw new AppError('NOT_FOUND', { entity: 'provider', detail: id }, 404);
	// Deleting the provider that does embedding leaves no embedder: explicit FTS-only mode (null, not
	// "absent" — absent would re-apply the legacy ollama default for a config that still lists ollama).
	if (resolveEmbeddingConfig(data)?.providerId === id) data.embedding = null;
	// Remove the provider from every task chain too — a dangling chain entry
	// would make chatWithFallback throw "Bilinmeyen provider" at request time.
	data.providers.splice(idx, 1);
	for (const taskType of Object.keys(data.chains)) {
		data.chains[taskType] = data.chains[taskType].filter((pid) => pid !== id);
	}
	writeFile(data);
}
