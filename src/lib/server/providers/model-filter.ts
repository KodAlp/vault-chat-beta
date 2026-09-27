import type { ModelInfo } from './types';
import { lookupCatalogEntry, type Catalog } from './model-catalog';
import type { ProviderConfigEntry } from './config-store';

/**
 * F14-3 — replaces the old `!m.embeddingOnly` one-liner (structurally Ollama-only: only ollama.ts's family
 * table ever set that flag) with a metadata-driven filter that works for every provider. Pure — takes an
 * already-loaded Catalog (model-catalog.ts owns the network/cache side), so this is trivially testable with
 * fabricated inputs.
 *
 * A model with a catalog entry is either APPROVED (kept) or dropped entirely (never shown, no override short
 * of the manual `enabledModels` list F14-4 adds elsewhere). A model with NO catalog entry is neither approved
 * nor dropped — it goes to OTHER, a demoted-but-not-deleted group, because "the catalog has never heard of
 * this id" is not the same claim as "this id is bad" (a very new or very small-provider model, e.g.).
 */

export interface FilterOptions {
	/** Closed by user decision at 12 (env.ts's modelMaxAgeMonths()), the caller passes it in rather than this
	 * module reading process.env — keeps this module free of env/IO entirely. */
	maxAgeMonths: number;
	now?: Date;
}

export interface FilterResult {
	approved: ModelInfo[];
	other: ModelInfo[];
}

const DAY_SECONDS = 86400;
const AVG_MONTH_DAYS = 30.44;

export function filterModels(providerId: string, models: readonly ModelInfo[], catalog: Catalog, opts: FilterOptions): FilterResult {
	const now = opts.now ?? new Date();
	const cutoff = now.getTime() / 1000 - opts.maxAgeMonths * AVG_MONTH_DAYS * DAY_SECONDS;

	const approved: ModelInfo[] = [];
	const other: ModelInfo[] = [];

	for (const m of models) {
		const entry = lookupCatalogEntry(catalog, providerId, m.id);
		if (!entry) {
			other.push(m);
			continue;
		}
		if (!entry.textOutput) continue;
		if (entry.deprecated) continue;
		const age = entry.releaseDate ?? m.created ?? null;
		if (age !== null && age < cutoff) continue;
		approved.push(m);
	}

	return { approved, other };
}

/**
 * Problem B — the single, shared list a picker actually shows for a provider, used by both
 * /api/providers/models (the chat/dialog picker) and /api/providers/[id]/models (the settings "manage
 * models" section), so the union-with-pinned logic lives in exactly one place.
 *
 * Steps: (1) run the catalog filter to get `approved` — SKIPPED (every listed model counts as approved) for
 * Ollama, a problem-A local provider, and Azure OpenAI, none of which have any catalog coverage worth
 * filtering against; (2) narrow by `enabledModels` when the user has curated one (same semantics as before —
 * it can only remove, never add, an approved id); (3) union in `pinnedModels` — a pinned id already present
 * keeps its live listModels() data, a pinned id NOT in `listed` (a catalog-unknown model, or an Azure
 * deployment name /models never returns) gets a conservative placeholder instead of being silently dropped.
 * Order: narrowed-approved first, then pinned-only entries, in the order pinnedModels was saved; never a
 * duplicate id.
 */
/** Providers whose model ids no cloud catalog knows: Ollama's own pulls, a user-declared local
 * OpenAI-compatible server, and Azure (the "model" is the user's deployment name). For these every
 * listed model counts as approved; filtering them against the catalog would hide all of them. */
export function skipsCatalog(entry: Pick<ProviderConfigEntry, 'kind' | 'local'>): boolean {
	return entry.kind === 'ollama' || entry.local === true || entry.kind === 'azure-openai';
}

export function pickerModels(
	entry: Pick<ProviderConfigEntry, 'id' | 'kind' | 'local' | 'enabledModels' | 'pinnedModels'>,
	listed: readonly ModelInfo[],
	catalog: Catalog,
	opts: FilterOptions
): ModelInfo[] {
	const approved = skipsCatalog(entry) ? [...listed] : filterModels(entry.id, listed, catalog, opts).approved;

	const allowed = entry.enabledModels !== undefined ? new Set(entry.enabledModels) : null;
	const narrowed = allowed ? approved.filter((m) => allowed.has(m.id)) : approved;

	const listedById = new Map(listed.map((m) => [m.id, m]));
	const seen = new Set(narrowed.map((m) => m.id));
	const result = [...narrowed];
	for (const pinnedId of entry.pinnedModels ?? []) {
		if (seen.has(pinnedId)) continue;
		seen.add(pinnedId);
		result.push(listedById.get(pinnedId) ?? { id: pinnedId, ctx: 8192, caps: { tools: false, reasoning: false } });
	}
	return result;
}
