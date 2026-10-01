import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	updateProviderEnabled,
	updateProviderDefaultModel,
	updateEnabledModels,
	updatePinnedModels,
	updateProviderLocal,
	updateModelCaps
} from '$lib/server/providers/config-store';
import { AppError, fail, toCodedError } from '$lib/server/app-error';
import type { ErrorCode } from '$lib/errors';

/** F14-4 — enabledModels: string[] sets the manual allow-list (settings page's checkbox management), null
 * clears it back to "uncurated, show everything the filter approves" (see config-store.ts's doc comment on
 * ProviderConfigEntry.enabledModels — an empty array is a real, distinct state from unset/null).
 * Problem B — pinnedModels: string[] | null follows the same null-clears semantics, validated/deduped in
 * config-store.ts's updatePinnedModels. Problem A — local: boolean toggles ProviderConfigEntry.local on an
 * existing openai-compat provider (no-op on any other kind, see updateProviderLocal's doc comment). */
export const PATCH: RequestHandler = async ({ params, request }) => {
	const body = (await request.json()) as {
		enabled?: boolean;
		defaultModel?: string | null;
		enabledModels?: string[] | null;
		pinnedModels?: string[] | null;
		local?: boolean;
		/** Aşama 4b — one model's capability override; `caps: null` clears it. */
		modelCaps?: { modelId: string; caps: { tools?: boolean; reasoning?: boolean } | null };
	};
	if (
		body.enabled === undefined &&
		body.defaultModel === undefined &&
		body.enabledModels === undefined &&
		body.pinnedModels === undefined &&
		body.local === undefined &&
		body.modelCaps === undefined
	) {
		fail('VALIDATION_REQUIRED_ANY', { fields: "'enabled', 'defaultModel', 'enabledModels', 'pinnedModels', 'local', 'modelCaps'" });
	}
	if (body.modelCaps !== undefined) {
		const mc = body.modelCaps;
		const capsOk =
			mc !== null &&
			typeof mc === 'object' &&
			typeof mc.modelId === 'string' &&
			(mc.caps === null ||
				(typeof mc.caps === 'object' &&
					(mc.caps.tools === undefined || typeof mc.caps.tools === 'boolean') &&
					(mc.caps.reasoning === undefined || typeof mc.caps.reasoning === 'boolean')));
		if (!capsOk) fail('VALIDATION_INVALID', { field: "'modelCaps'" });
	}
	if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
		fail('VALIDATION_INVALID', { field: "'enabled'" });
	}
	if (body.enabledModels !== undefined && body.enabledModels !== null && !Array.isArray(body.enabledModels)) {
		fail('VALIDATION_INVALID', { field: "'enabledModels'" });
	}
	if (body.pinnedModels !== undefined && body.pinnedModels !== null && !Array.isArray(body.pinnedModels)) {
		fail('VALIDATION_INVALID', { field: "'pinnedModels'" });
	}
	if (body.local !== undefined && typeof body.local !== 'boolean') {
		fail('VALIDATION_INVALID', { field: "'local'" });
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
		if (body.pinnedModels !== undefined) {
			updatePinnedModels(params.id, body.pinnedModels);
		}
		if (body.local !== undefined) {
			updateProviderLocal(params.id, body.local);
		}
		if (body.modelCaps !== undefined) {
			updateModelCaps(params.id, body.modelCaps.modelId, body.modelCaps.caps);
		}
		return json({
			id: params.id,
			enabled: body.enabled,
			defaultModel: body.defaultModel,
			enabledModels: body.enabledModels,
			pinnedModels: body.pinnedModels,
			local: body.local,
			modelCaps: body.modelCaps
		});
	} catch (err) {
		if (err instanceof AppError) fail(err.code, err.params, err.status);
		const coded = toCodedError(err);
		fail(coded.code as ErrorCode, coded.params, 404);
	}
};
