import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { updateProviderEnabled, updateProviderDefaultModel, updateEnabledModels } from '$lib/server/providers/config-store';

/** F14-4 — enabledModels: string[] sets the manual allow-list (settings page's checkbox management), null
 * clears it back to "uncurated, show everything the filter approves" (see config-store.ts's doc comment on
 * ProviderConfigEntry.enabledModels — an empty array is a real, distinct state from unset/null). */
export const PATCH: RequestHandler = async ({ params, request }) => {
	const body = (await request.json()) as { enabled?: boolean; defaultModel?: string | null; enabledModels?: string[] | null };
	if (body.enabled === undefined && body.defaultModel === undefined && body.enabledModels === undefined) {
		error(400, "'enabled', 'defaultModel' veya 'enabledModels' gerekli");
	}
	if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
		error(400, "'enabled' boolean olmalı");
	}
	if (body.enabledModels !== undefined && body.enabledModels !== null && !Array.isArray(body.enabledModels)) {
		error(400, "'enabledModels' bir dizi ya da null olmalı");
	}

	try {
		if (body.enabled !== undefined) {
			updateProviderEnabled(params.id, body.enabled);
		}
		if (body.defaultModel !== undefined) {
			updateProviderDefaultModel(params.id, body.defaultModel);
		}
		if (body.enabledModels !== undefined) {
			updateEnabledModels(params.id, body.enabledModels);
		}
		return json({ id: params.id, enabled: body.enabled, defaultModel: body.defaultModel, enabledModels: body.enabledModels });
	} catch (err) {
		error(404, err instanceof Error ? err.message : 'Bilinmeyen provider');
	}
};
