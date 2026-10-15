import type { ErrorParams } from './errors';
import { isStockOllamaName } from './provider-label';

/**
 * Pure formatting core for a coded server error — no i18n import, no DOM,
 * no rune. Takes `translate` as a parameter instead of importing `t` from
 * i18n/index.svelte.ts directly so this file (and its logic) can be unit
 * tested under plain `tsx --test` with a fake dictionary; the real client
 * wrapper is server-error.ts's `localizeError`, which passes the real `t`.
 *
 * Resolution order:
 *  1. `e.code` present -> resolve `params.entity` (if any) through
 *     `ServerErrors.entity_<name>`, then translate `ServerErrors.<code>`.
 *     A translation miss (translate() echoing the raw key back, i18n's own
 *     documented missing-key behavior) falls through to step 2 rather than
 *     showing the user a raw code string.
 *  2. `e.message` present and NOT itself a bare code (e.g. a ProviderError's
 *     raw `.message`, which is human prose, not a code) -> use it verbatim.
 *  3. `fallback`.
 *
 * `params.detail` (typically a provider's raw error text, see
 * app-error.ts's toCodedError) is appended after a translated string with
 * an em-dash separator, UNLESS the translation already contains it
 * verbatim — guards against double-printing the same text when a catalog
 * entry is later rewritten to already quote the detail inline.
 */
export function formatCodedError(
	e: { code?: string; params?: ErrorParams; message?: string } | null | undefined,
	translate: (key: string, params?: ErrorParams) => string,
	fallback: string
): string {
	if (e?.code) {
		const params: ErrorParams = { ...(e.params ?? {}) };

		if (typeof params.entity === 'string') {
			const entityKey = 'ServerErrors.entity_' + params.entity;
			const resolvedEntity = translate(entityKey);
			if (resolvedEntity !== entityKey) {
				params.entity = resolvedEntity;
			}
		}

		if (typeof params.reason === 'string') {
			const reasonKey = 'ServerErrors.reason_' + params.reason;
			const resolvedReason = translate(reasonKey, params);
			if (resolvedReason !== reasonKey) {
				params.reason = resolvedReason;
			}
		}

		// A provider name in a fallback notice: the built-in Ollama entry's stock label is Turkish
		// ("Ollama (yerel)") in every install, so it is localized here like entity/reason above.
		for (const name of ['provider', 'from', 'to'] as const) {
			const value = params[name];
			if (typeof value === 'string' && isStockOllamaName(value)) {
				const localized = translate('ProvidersSettingsPage.ollamaLocal');
				if (localized !== 'ProvidersSettingsPage.ollamaLocal') params[name] = localized;
			}
		}

		const key = 'ServerErrors.' + e.code;
		let translated = translate(key, params);
		if (translated !== key) {
			// Append reason and detail only when the template didn't already
			// interpolate them, so one param never prints twice.
			for (const extra of [params.reason, params.detail]) {
				if (typeof extra === 'string' && extra.length > 0 && !translated.includes(extra)) {
					translated += ' — ' + extra;
				}
			}
			return translated;
		}
	}

	if (typeof e?.message === 'string' && e.message.length > 0 && !/^[A-Z][A-Z0-9_]+$/.test(e.message)) {
		return e.message;
	}

	return fallback;
}
