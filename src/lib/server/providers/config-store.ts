import fs from 'node:fs';
import { providersPath } from '../env';

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
	kind: 'ollama' | 'openai-compat' | 'anthropic';
	reasoningDialect: 'think-tags' | 'reasoning_content' | 'none';
	enabled: boolean;
	timeouts: { connectMs: number; firstTokenMs: number; idleMs: number };
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
}

/** Cloud providers are OpenAI-compatible except Anthropic — this drives the
 * settings UI's "add provider" form (which fields to show) and the badge. */
export function isCloud(kind: ProviderConfigEntry['kind']): boolean {
	return kind !== 'ollama';
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
	if (!entry) throw new Error(`Bilinmeyen provider: ${id}`);
	// registry.ts's chatWithFallback now actually honors this flag (routing
	// used to ignore it entirely) — disabling Ollama would leave every task
	// with an empty chain the instant no other provider happens to be
	// enabled, breaking the "Ollama always works, even offline" guarantee
	// this app is built around. Mirrors deleteProvider()'s existing
	// "Ollama kaldırılamaz" guard below.
	if (id === 'ollama' && !enabled) throw new Error('Ollama devre dışı bırakılamaz');
	entry.enabled = enabled;
	writeFile(data);
	return entry;
}

export function updateProviderDefaultModel(id: string, defaultModel: string | null): void {
	const data = readFile();
	const entry = data.providers.find((p) => p.id === id);
	if (!entry) throw new Error(`Bilinmeyen provider: ${id}`);
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
	if (!entry) throw new Error(`Bilinmeyen provider: ${id}`);
	if (modelIds === null) delete entry.enabledModels;
	else entry.enabledModels = modelIds;
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
	kind: 'openai-compat' | 'anthropic';
	reasoningDialect: 'think-tags' | 'reasoning_content' | 'none';
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
	const entry: ProviderConfigEntry = {
		id,
		label: input.label.trim(),
		baseUrl: input.baseUrl.trim(),
		kind: input.kind,
		reasoningDialect: input.reasoningDialect,
		enabled: false,
		timeouts: { connectMs: 5000, firstTokenMs: 30000, idleMs: 30000 }
	};
	data.providers.push(entry);
	writeFile(data);
	return entry;
}

export function deleteProvider(id: string): void {
	const data = readFile();
	const idx = data.providers.findIndex((p) => p.id === id);
	if (idx === -1) throw new Error(`Bilinmeyen provider: ${id}`);
	if (id === 'ollama') throw new Error('Ollama kaldırılamaz');
	// Remove the provider from every task chain too — a dangling chain entry
	// would make chatWithFallback throw "Bilinmeyen provider" at request time.
	data.providers.splice(idx, 1);
	for (const taskType of Object.keys(data.chains)) {
		data.chains[taskType] = data.chains[taskType].filter((pid) => pid !== id);
	}
	writeFile(data);
}
