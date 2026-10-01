import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { readProvidersFile } from '$lib/server/providers/config-store';
import { getAdapter } from '$lib/server/providers/registry';
import { loadCatalog } from '$lib/server/providers/model-catalog';
import { filterModels, skipsCatalog } from '$lib/server/providers/model-filter';
import { modelMaxAgeMonths } from '$lib/server/env';
import type { ModelListItem } from '$lib/types';
import { fail } from '$lib/server/app-error';

/**
 * F14-4 — the settings page's "model listesini yönet" section: unlike GET /api/providers/models (which only
 * ever returns the clean, already-filtered list every picker uses), this shows BOTH buckets model-filter.ts
 * produces — approved (F14-3 passed) and other (not in either catalog, demoted not deleted) — each tagged
 * with whether it's currently in the provider's enabledModels allow-list, so the checkbox UI can render
 * without a second round-trip. Ollama, a problem-A local provider, and Azure OpenAI are excluded from the
 * catalog filter (same skip pickerModels applies) — every one of their non-embedding models is "approved"
 * here too. Problem B's pinnedModels is returned separately as `pinned` (raw ids, in save order) — a pinned
 * id may or may not also appear in `approved`/`other` depending on whether it was in this provider's live
 * listModels() result; the settings UI renders it as its own removable list either way.
 */
export const GET: RequestHandler = async ({ params }) => {
	const { providers } = readProvidersFile();
	const p = providers.find((x) => x.id === params.id);
	if (!p) fail('NOT_FOUND', { entity: 'provider', detail: params.id }, 404);

	const adapter = await getAdapter(p.id);
	const listed = await adapter.listModels();
	const models = listed.filter((m) => !m.embeddingOnly);
	// Aşama 4c: the embedding-only models the picker lists above hide — the first-run wizard offers them as
	// the vault's embedding model (shared model-caps.ts decides what counts as embedding-only).
	const embedding = listed.filter((m) => m.embeddingOnly).map((m) => m.id);

	const { approved, other } = skipsCatalog(p)
		? { approved: models, other: [] }
		: filterModels(p.id, models, await loadCatalog(), { maxAgeMonths: modelMaxAgeMonths() });

	const allowed = p.enabledModels !== undefined ? new Set(p.enabledModels) : null;
	// caps = the EFFECTIVE flags (adapter.listModels already applied table + override); `override` is what the
	// user explicitly set, so the settings toggles can show both.
	const toItem = (m: (typeof models)[number]): ModelListItem => ({
		id: m.id,
		enabled: allowed ? allowed.has(m.id) : true,
		caps: m.caps,
		...(p.modelCaps?.[m.id] ? { capsOverride: p.modelCaps[m.id] } : {})
	});

	return json({ approved: approved.map(toItem), other: other.map(toItem), pinned: p.pinnedModels ?? [], embedding });
};
