import crypto from 'node:crypto';

/**
 * Güvenlik sertleştirme — pure decision logic for the packaged desktop
 * build's per-launch session token, extracted out of hooks.server.ts's
 * `handle` so it can be unit-tested without spinning up SvelteKit (same
 * reasoning as resume-plan.ts's planRecovery/planSeam). hooks.server.ts owns
 * all the I/O — reading the query string, the `vc_session` cookie, the
 * `x-vc-session` header, and acting on the decision (setting the cookie,
 * issuing the 303, throwing the 401) — this module only decides WHAT to do.
 *
 * Contract with the Rust side (src-tauri/src/lib.rs's spawn_sidecar): in the
 * packaged app only, Rust generates a fresh 64-hex-char token per launch,
 * passes it as env VC_SESSION_TOKEN (see env.ts's sessionToken()), and
 * points the webview's first navigation at
 * `http://127.0.0.1:{port}/?vc_session={token}`. Under plain `npm run dev`,
 * `npm test`, or the MCP server the env var is unset and this module is
 * never consulted at all — hooks.server.ts only calls into it when a token
 * is configured, so "no token" behaves EXACTLY as before this feature
 * existed.
 *
 * Everything here is loopback-only defense in depth, not a real multi-user
 * auth system: the token's only job is to stop OTHER local processes/users
 * on the same machine (or a page that manages to reach 127.0.0.1 despite
 * the CROSS_SITE_BLOCKED/LOCAL_ONLY checks in hooks.server.ts) from talking
 * to a sidecar that would otherwise trust literally anything that can open
 * a TCP connection to its port.
 */

/** What hooks.server.ts's `handle` should do for one request once a session
 * token is configured. `redirect`'s `location` is the same path+query the
 * request arrived with, minus the `vc_session` param — set the cookie, THEN
 * redirect, so the token never lingers in the URL bar/history/referrer past
 * this one response. */
export type SessionGateDecision =
	| { kind: 'allow' }
	| { kind: 'redirect'; location: string }
	| { kind: 'reject' };

/**
 * Timing-safe string equality. crypto.timingSafeEqual throws on unequal
 * buffer lengths (it refuses to guess which side to pad), so a length
 * mismatch is checked first and short-circuits to `false` — this leaks
 * "lengths differ" via timing, never the token's own bytes, which is the
 * property that matters for a bearer-token comparison. Also doubles as the
 * empty-string guard: two zero-length inputs are trivially "equal" by
 * `Buffer.alloc(0)` semantics, so callers must never pass an empty
 * candidate through as if it were "no candidate" — see decideSessionGate's
 * `string | null` inputs below, where "no candidate" is `null`, not `''`.
 */
export function timingSafeEqualString(a: string, b: string): boolean {
	const bufA = Buffer.from(a, 'utf8');
	const bufB = Buffer.from(b, 'utf8');
	if (bufA.length !== bufB.length) return false;
	return crypto.timingSafeEqual(bufA, bufB);
}

export interface SessionGateInput {
	/** The configured VC_SESSION_TOKEN. Callers only invoke this function at
	 * all once they know a token is configured — never call it with `''`. */
	token: string;
	/** `event.url.searchParams.get('vc_session')` — `null` when absent. */
	queryToken: string | null;
	/** `event.cookies.get('vc_session')` — `null` when absent. */
	cookieToken: string | null;
	/** `event.request.headers.get('x-vc-session')` — `null` when absent. */
	headerToken: string | null;
	/** `event.url.pathname`, used to build the post-redirect location. */
	pathname: string;
	/** `event.url.searchParams` — read-only; this function never mutates the
	 * caller's instance (it builds its own copy before deleting `vc_session`
	 * off it). */
	searchParams: URLSearchParams;
}

/**
 * The redirect target for the first-navigation URL
 * (`/?vc_session={token}`): same path and remaining query string, with
 * `vc_session` itself stripped. A bare pathname (no leftover params) is
 * returned without a trailing `?`, matching how SvelteKit's own `redirect()`
 * expects a location.
 */
function locationWithoutSessionParam(pathname: string, searchParams: URLSearchParams): string {
	const remaining = new URLSearchParams(searchParams);
	remaining.delete('vc_session');
	const qs = remaining.toString();
	return qs ? `${pathname}?${qs}` : pathname;
}

/**
 * Decides what to do with one request once a session token is configured.
 *
 * Order matters and is deliberate:
 * 1. A matching `?vc_session=` query param wins outright, even if a stale/
 *    wrong cookie or header is also present — this is how the token gets
 *    turned into a cookie in the first place, and a fresh, correct query
 *    token should never be second-guessed by leftover state from a previous
 *    launch (a new VC_SESSION_TOKEN is minted every launch, so an old
 *    cookie from a prior run is expected to mismatch).
 * 2. Otherwise, a matching cookie OR header allows the request — the cookie
 *    is what the browser sends automatically on every subsequent webview
 *    request after step 1's redirect; the header exists for any non-cookie
 *    caller (a spawned child process calling back into this same server,
 *    if one ever needs to — see hooks.server.ts's own doc comment on why
 *    none currently do).
 * 3. Anything else is rejected. A query param that ARRIVED but did not
 *    match the token does not short-circuit to reject — it still falls
 *    through to the cookie/header check in step 2, since a request can
 *    legitimately carry both an old/garbage query param and a valid
 *    cookie (e.g. a bookmarked URL from a previous launch, refetched by a
 *    real user who already has a live session cookie).
 */
export function decideSessionGate(input: SessionGateInput): SessionGateDecision {
	if (input.queryToken !== null && timingSafeEqualString(input.queryToken, input.token)) {
		return { kind: 'redirect', location: locationWithoutSessionParam(input.pathname, input.searchParams) };
	}
	if (input.cookieToken !== null && timingSafeEqualString(input.cookieToken, input.token)) {
		return { kind: 'allow' };
	}
	if (input.headerToken !== null && timingSafeEqualString(input.headerToken, input.token)) {
		return { kind: 'allow' };
	}
	return { kind: 'reject' };
}
