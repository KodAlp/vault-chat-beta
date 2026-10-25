import type { RequestHandler } from './$types';
import { listEnabledProviders, getAdapter } from '#lib/server/providers/registry.js';
import { loadCatalog } from '#lib/server/providers/model-catalog.js';
import { pickerModels } from '#lib/server/providers/model-filter.js';
import { modelMaxAgeMonths } from '#lib/server/env.js';
import { isCloud } from '#lib/server/providers/config-store.js';
import { isProviderConsented } from '#lib/server/provider-consent.js';
import type { ProviderModelOption } from '#lib/types.js';

/** Aggregates listModels() across every enabled provider, tagged with the
 * provider that owns each model — feeds both the chat header's per-chat
 * override selector and (later) the settings model info. Best-effort per
 * provider: a single unreachable provider must not blank out the whole
 * list (each adapter's own listModels() already swallows its own
 * fetch failures, see openai-compat.ts).
 *
 * The old single `!m.embeddingOnly` line (structurally Ollama-only) is now the FIRST pass; the second
 * pass runs every model through model-filter.ts's pickerModels — catalog filter (skipped for Ollama, a
 * problem-A local provider, and Azure OpenAI), narrowed by enabledModels when curated, unioned with
 * pinnedModels (problem B: a catalog-unknown or /models-unlisted model id the user explicitly pinned).
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
				const final = pickerModels(p, models, catalog, { maxAgeMonths });
				// Computed once per provider, not per model —
				// consent is granted/revoked for the whole provider, never a
				// single model within it.
				const cloud = isCloud(p);
				const consented = !cloud || isProviderConsented(p.id);
				return final.map<ProviderModelOption>((m) => ({
					providerId: p.id,
					providerLabel: p.label,
					id: m.id,
					ctx: m.ctx,
					caps: m.caps,
					cloud,
					consented
				}));
			} catch {
				return [];
			}
		})
	);
	return Response.json(results.flat());
};
