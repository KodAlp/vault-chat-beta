/**
 * Phase 1 (hardening) — stable, locale-independent error codes shared by
 * every server surface. These are never shown to the user directly: the
 * client resolves each one through ServerErrors.<CODE> in
 * src/lib/i18n/messages/{tr,en}.json via formatCodedError() (error-format.ts).
 * Adding a code here without a matching ServerErrors entry in BOTH catalogs
 * fails error-catalog.test.ts.
 *
 * One PROVIDER_<KIND> per ProviderErrorKind (see
 * src/lib/server/providers/types.ts) — kept in lockstep by hand since the
 * kind union lives in a runtime-agnostic types file this module doesn't
 * import from (avoids a server/ -> isomorphic dependency edge just for a
 * string list).
 */
export const COMMON_CODES = [
	'UNKNOWN',
	'INTERNAL',
	'ROUTE_NOT_FOUND',
	'NOT_FOUND',
	'VALIDATION_REQUIRED',
	'VALIDATION_INVALID',
	'REQUEST_FAILED',
	'NO_SOURCES',
	'NO_SOURCES_NARROW',
	'PROVIDER_NETWORK',
	'PROVIDER_TIMEOUT_CONNECT',
	'PROVIDER_TIMEOUT_FIRST_TOKEN',
	'PROVIDER_TIMEOUT_IDLE',
	'PROVIDER_HTTP_429',
	'PROVIDER_HTTP_5XX',
	'PROVIDER_AUTH',
	'PROVIDER_BAD_REQUEST',
	'PROVIDER_CONTEXT_LENGTH',
	'PROVIDER_UNKNOWN'
] as const;
