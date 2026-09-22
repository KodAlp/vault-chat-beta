import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listEnabledProviders, getAdapter } from '$lib/server/providers/registry';
import { loadCatalog } from '$lib/server/providers/model-catalog';
import { filterModels, type FilterResult } from '$lib/server/providers/model-filter';
import { modelMaxAgeMonths } from '$lib/server/env';
import type { ProviderConfigEntry } from '$lib/server/providers/config-store';
import type { ModelInfo } from '$lib/server/providers/types';
import type { ProviderModelOption } from '$lib/types';

/** Ollama already has its own metadata source (ollama.ts's MODEL_FAMILY_TABLE — embeddingOnly, ctx, caps) for
 * models the user explicitly pulled themselves; there is no "deprecated"/"too old" concept for a local model
 * in the way there is for a cloud catalog, and it is not in either external catalog anyway (those only cover
 * cloud APIs) — every id would land in "other" for the wrong reason. F14-3's catalog filter is for cloud
 * providers only; Ollama's non-embedding models are all "approved" as-is, same as before F14. */
async function approvedModels(p: ProviderConfigEntry, models: ModelInfo[], catalog: Awaited<ReturnType<typeof loadCatalog>>, maxAgeMonths: number): Promise<FilterResult> {
	if (p.id === 'ollama') return { approved: models, other: [] };
	return filterModels(p.id, models, catalog, { maxAgeMonths });
}

/** Aggregates listModels() across every enabled provider, tagged with the
 * provider that owns each model — feeds both the chat header's per-chat
 * override selector and (later) the settings model info. Best-effort per
 * provider: a single unreachable provider must not blank out the whole
 * list (each adapter's own listModels() already swallows its own
 * fetch failures, see openai-compat.ts).
 *
 * F14: the old single `!m.embeddingOnly` line (structurally Ollama-only) is now the FIRST pass; the second
 * pass runs every non-Ollama provider's models through the F14-2/3 catalog-based filter (deprecated/
 * non-text-output/too-old dropped, catalog-unmatched demoted to "other" and excluded HERE — the settings
 * page's own /manage endpoint is what shows "other"). A provider's manual enabledModels allow-list (F14-4),
 * when set, narrows the result further — it can only remove ids the filter already approved, never add one
 * back that was dropped.
 */
export const GET: RequestHandler = async () => {
	const providers = listEnabledProviders();
	const catalog = await loadCatalog();
	const maxAgeMonths = modelMaxAgeMonths();
	const results = await Promise.all(
		providers.map(async (p) => {
			try {
				const adapter = await getAdapter(p.id);
				const models = (await adapter.listModels()).filter((m) => !m.embeddingOnly);
				const { approved } = await approvedModels(p, models, catalog, maxAgeMonths);
				const allowed = p.enabledModels !== undefined ? new Set(p.enabledModels) : null;
				const final = allowed ? approved.filter((m) => allowed.has(m.id)) : approved;
				return final.map<ProviderModelOption>((m) => ({
					providerId: p.id,
					providerLabel: p.label,
					id: m.id,
					ctx: m.ctx,
					caps: m.caps
				}));
			} catch {
				return [];
			}
		})
	);
	return json(results.flat());
};
