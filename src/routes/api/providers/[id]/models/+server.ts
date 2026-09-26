import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { readProvidersFile } from '$lib/server/providers/config-store';
import { getAdapter } from '$lib/server/providers/registry';
import { loadCatalog } from '$lib/server/providers/model-catalog';
import { filterModels } from '$lib/server/providers/model-filter';
import { modelMaxAgeMonths } from '$lib/server/env';
import type { ModelListItem } from '$lib/types';
import { fail } from '$lib/server/app-error';

/**
 * F14-4 — the settings page's "model listesini yönet" section: unlike GET /api/providers/models (which only
 * ever returns the clean, already-filtered list every picker uses), this shows BOTH buckets model-filter.ts
 * produces — approved (F14-3 passed) and other (not in either catalog, demoted not deleted) — each tagged
 * with whether it's currently in the provider's enabledModels allow-list, so the checkbox UI can render
 * without a second round-trip. Ollama is excluded from the catalog filter (see api/providers/models's own
 * doc comment) — every one of its non-embedding models is "approved" here too.
 */
export const GET: RequestHandler = async ({ params }) => {
	const { providers } = readProvidersFile();
	const p = providers.find((x) => x.id === params.id);
	if (!p) fail('NOT_FOUND', { entity: 'provider', detail: params.id }, 404);

	const adapter = await getAdapter(p.id);
	const models = (await adapter.listModels()).filter((m) => !m.embeddingOnly);

	const { approved, other } =
		p.id === 'ollama' ? { approved: models, other: [] } : filterModels(p.id, models, await loadCatalog(), { maxAgeMonths: modelMaxAgeMonths() });

	const allowed = p.enabledModels !== undefined ? new Set(p.enabledModels) : null;
	const toItem = (m: (typeof models)[number]): ModelListItem => ({ id: m.id, enabled: allowed ? allowed.has(m.id) : true });

	return json({ approved: approved.map(toItem), other: other.map(toItem) });
};
