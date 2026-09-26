import { t } from './i18n/index.svelte';
import { formatCodedError } from './error-format';
import type { ErrorParams } from './errors';

/**
 * Client-side wrapper around formatCodedError, wired to the real i18n `t`.
 * Use this wherever a caught error (a SvelteKit `error(status, {code,...})`
 * thrown server-side, a `toCodedError()`/`errorPayload()` object from an SSE
 * `error` event, or a plain Error) needs to become user-facing text.
 */
export function localizeError(e: { code?: string; params?: ErrorParams; message?: string } | null | undefined): string {
	return formatCodedError(e, t, t('Common.bilinmeyenHata'));
}

/**
 * Reads a non-ok fetch Response's body and turns it into localized text.
 * Never throws — an unparsable/non-JSON body (a proxy's HTML error page, a
 * connection dropped mid-response) falls back to a generic "request failed
 * (status)" message rather than surfacing a raw parse error.
 *
 * Accepts every shape this app's server side can produce:
 *  - SvelteKit's own error body: `{ message, code?, params? }` (see
 *    app-error.ts's `fail()`, and hooks.server.ts's `handleError`).
 *  - Legacy ad-hoc shapes still in use pre-Phase-2 conversion:
 *    `{ error: string }` and `{ error: { code, params } }`.
 */
export async function readResponseError(res: Response): Promise<string> {
	try {
		const body: unknown = await res.json();
		if (body && typeof body === 'object') {
			const b = body as Record<string, unknown>;

			if (typeof b.error === 'string') {
				return localizeError({ message: b.error });
			}

			if (b.error && typeof b.error === 'object') {
				const err = b.error as Record<string, unknown>;
				return localizeError({
					code: typeof err.code === 'string' ? err.code : undefined,
					params: (err.params as ErrorParams | undefined) ?? undefined,
					message: typeof err.message === 'string' ? err.message : undefined
				});
			}

			if (typeof b.code === 'string' || typeof b.message === 'string') {
				return localizeError({
					code: typeof b.code === 'string' ? b.code : undefined,
					params: (b.params as ErrorParams | undefined) ?? undefined,
					message: typeof b.message === 'string' ? b.message : undefined
				});
			}
		}
	} catch {
		// Body wasn't JSON (or reading it failed) — fall through to the generic message below.
	}
	return t('Common.istekBasarisiz', { status: res.status });
}
