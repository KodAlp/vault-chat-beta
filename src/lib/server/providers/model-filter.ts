import type { ModelInfo } from './types';
import { lookupCatalogEntry, type Catalog } from './model-catalog';

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
