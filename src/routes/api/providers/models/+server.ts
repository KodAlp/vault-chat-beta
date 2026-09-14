import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listEnabledProviders, getAdapter } from '$lib/server/providers/registry';
import type { ProviderModelOption } from '$lib/types';

/** Aggregates listModels() across every enabled provider, tagged with the
 * provider that owns each model — feeds both the chat header's per-chat
 * override selector and (later) the settings model info. Best-effort per
 * provider: a single unreachable provider must not blank out the whole
 * list (each adapter's own listModels() already swallows its own
 * fetch failures, see openai-compat.ts). */
export const GET: RequestHandler = async () => {
	const providers = listEnabledProviders();
	const results = await Promise.all(
		providers.map(async (p) => {
			try {
				const adapter = await getAdapter(p.id);
				const models = await adapter.listModels();
				// Embedding-only models (bge-m3, nomic-embed-text) have no chat
				// template — Ollama's /api/tags lists them next to real chat
				// models with no other way to tell them apart, so every picker
				// that reads this endpoint would otherwise offer a model that
				// silently fails when used for chat/generation.
				return models
					.filter((m) => !m.embeddingOnly)
					.map<ProviderModelOption>((m) => ({
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
