/**
 * Phase 1 (hardening) — the server-side half of the coded-error scheme.
 * Every route/generator throws or reports through here instead of a
 * hardcoded Turkish string, so the client can render the failure through
 * `t()` regardless of the active locale. See src/lib/errors.ts (isomorphic
 * registry), src/lib/error-format.ts (client rendering), and
 * ServerErrors.* in the i18n catalogs.
 *
 * ProviderError/NoSourcesError are imported by relative path (not the
 * `$lib/...` alias) so this file — and its `toCodedError` classification
 * logic — can be loaded and unit-tested directly under plain `tsx --test`,
 * the same reasoning config-store.test.ts etc. already rely on.
 */
import { error } from '@sveltejs/kit';
import { ALL_ERROR_CODES, type ErrorCode, type ErrorParams, type CodedError } from '../errors';
import { ProviderError } from './providers/types';
import { NoSourcesError } from './generate-errors';

/**
 * Thrown by route/server code that wants a specific status + code. `message`
 * is set to the code (plus a JSON dump of params) purely so logs/stack
 * traces are legible — it is NEVER shown to the user; the client always
 * renders via `code`/`params` through ServerErrors.*, never `.message`.
 */
export class AppError extends Error {
	readonly code: ErrorCode;
	readonly params?: ErrorParams;
	readonly status: number;

	constructor(code: ErrorCode, params?: ErrorParams, status = 400) {
		super(params ? `${code} ${JSON.stringify(params)}` : code);
		this.name = 'AppError';
		this.code = code;
		this.params = params;
		this.status = status;
	}
}

/**
 * Throws a SvelteKit HTTP error carrying a code the client can localize.
 * `message` is set to the raw code as a legible fallback for anything that
 * still reads `App.Error.message` directly (SvelteKit's own default error
 * page, non-JS clients) — the real client code path renders via `code`/
 * `params` instead (see error-format.ts).
 */
export function fail(code: ErrorCode, params?: ErrorParams, status = 400): never {
	return error(status, { message: code, code, params });
}

/** Structural shape of a SvelteKit HttpError as thrown by `error()` — not
 * exported by @sveltejs/kit as a type guard, so checked by shape here. */
interface HttpErrorLike {
	status: number;
	body: { message?: unknown; code?: unknown; params?: unknown };
}

function isHttpErrorLike(err: unknown): err is HttpErrorLike {
	return (
		typeof err === 'object' &&
		err !== null &&
		'status' in err &&
		'body' in err &&
		typeof (err as { body: unknown }).body === 'object' &&
		(err as { body: unknown }).body !== null
	);
}

/**
 * Classifies anything this app might throw/catch into a {code, params} the
 * client can localize. Every branch here is a judgment call about what
 * params a given failure kind carries — keep it in sync with
 * ServerErrors.* in both catalogs (error-catalog.test.ts enforces that).
 */
export function toCodedError(err: unknown): CodedError {
	if (err instanceof AppError) {
		return { code: err.code, params: err.params };
	}

	if (err instanceof ProviderError) {
		return {
			code: 'PROVIDER_' + err.kind.toUpperCase(),
			params: { provider: err.providerId, detail: err.message }
		};
	}

	if (err instanceof NoSourcesError) {
		return { code: err.narrowScope ? 'NO_SOURCES_NARROW' : 'NO_SOURCES' };
	}

	if (isHttpErrorLike(err)) {
		if (typeof err.body.code === 'string') {
			return { code: err.body.code, params: err.body.params as ErrorParams | undefined };
		}
		// SvelteKit's HttpError is not an Error subclass, so an uncoded
		// error(status, 'text') would otherwise reach the bare fallback below
		// and lose its text.
		if (typeof err.body.message === 'string') {
			return { code: 'UNKNOWN', params: { detail: err.body.message } };
		}
	}

	// Plain Errors from modules that must stay free of kit/AppError imports (library-read.ts) carry a registry code
	// as a string property; node errno codes (ENOENT, ...) are not in the registry so they fall through below.
	const plainCode = err instanceof Error ? (err as { code?: unknown }).code : undefined;
	if (typeof plainCode === 'string' && (ALL_ERROR_CODES as readonly string[]).includes(plainCode)) {
		return { code: plainCode };
	}

	if (err instanceof Error) {
		return { code: 'UNKNOWN', params: { detail: err.message } };
	}

	return { code: 'UNKNOWN' };
}

/**
 * Same classification as toCodedError, plus `message` set to the code
 * itself — the shape SSE `error` events send over the wire
 * (`send({ type: 'error', ...errorPayload(err) })`), so a client that only
 * reads `.message` (an older build, a non-UI consumer) still gets a stable
 * string instead of nothing.
 */
export function errorPayload(err: unknown): { code: string; params?: ErrorParams; message: string } {
	const coded = toCodedError(err);
	return { ...coded, message: coded.code };
}
