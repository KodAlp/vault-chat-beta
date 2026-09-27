import fs from 'node:fs';
import { providersPath } from '../env';
import { AppError } from '../app-error';

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
}

/** Cloud providers are every kind except Ollama (always local) and an openai-compat entry the user has
 * marked `local: true` (problem A) — this drives the settings UI's "add provider" form, the cloud badge, and
 * whether the cloud-consent dialog is shown before a model picker switches onto it. Takes the whole entry
 * (or a pick of it) rather than just `kind` now that locality is no longer implied by kind alone. */
export function isCloud(entry: Pick<ProviderConfigEntry, 'kind' | 'local'>): boolean {
	return entry.kind !== 'ollama' && !entry.local;
}

export interface ProvidersFile {
	providers: ProviderConfigEntry[];
	chains: Record<string, string[]>;
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
	// registry.ts's chatWithFallback now actually honors this flag (routing
	// used to ignore it entirely) — disabling Ollama would leave every task
	// with an empty chain the instant no other provider happens to be
	// enabled, breaking the "Ollama always works, even offline" guarantee
	// this app is built around. Mirrors deleteProvider()'s existing
	// PROVIDER_OLLAMA_UNDELETABLE guard below.
	if (id === 'ollama' && !enabled) throw new AppError('PROVIDER_OLLAMA_REQUIRED');
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

export function updateChain(taskType: string, providerIds: string[]): void {
	const data = readFile();
	data.chains[taskType] = providerIds;
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
	if (id === 'ollama') throw new AppError('PROVIDER_OLLAMA_UNDELETABLE');
	// Remove the provider from every task chain too — a dangling chain entry
	// would make chatWithFallback throw "Bilinmeyen provider" at request time.
	data.providers.splice(idx, 1);
	for (const taskType of Object.keys(data.chains)) {
		data.chains[taskType] = data.chains[taskType].filter((pid) => pid !== id);
	}
	writeFile(data);
}
