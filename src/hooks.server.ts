import { error, redirect, type Handle, type HandleServerError, type RequestEvent } from '@sveltejs/kit';
import { runVaultMigrationIfNeeded } from '$lib/server/migrateVaults';
import { logAppEvent } from '$lib/server/app-log';
import { sessionToken } from '$lib/server/env';
import { decideSessionGate } from '$lib/server/session-gate';
import tls from 'node:tls';
import { installSystemCa } from '$lib/server/system-ca';

// Before any cloud provider call: trust the OS certificate store too, so antivirus / corporate HTTPS
// inspection doesn't break every provider with SELF_SIGNED_CERT_IN_CHAIN. See system-ca.ts.
{
	const ca = installSystemCa(tls, process.env);
	if (!ca.installed && ca.reason !== 'disabled') {
		process.stderr.write(`system CA not installed: ${ca.reason}${'detail' in ca && ca.detail ? ` (${ca.detail})` : ''}\n`);
	}
}

// Runs once per server process start, before any request is handled —
// exactly what a one-time "migrate legacy single-library layout to the
// vault registry" step needs. See vault-registry skill.
runVaultMigrationIfNeeded();

// Nothing in this app installed these before — Node's default behavior for
// either is to print to stderr and kill the whole process. Installing a
// handler suppresses that default printing, so each handler below writes
// to stderr ITSELF, first — the packaged desktop build's Rust side now
// continuously drains the sidecar's stdout/stderr for its whole life (see
// spawn_sidecar in src-tauri/src/lib.rs), so this is what actually reaches
// launch.log. logAppEvent's data/app-log.jsonl entry is the durable,
// structured second copy, not the only copy.
process.on('uncaughtException', (err) => {
	const text = err instanceof Error ? (err.stack ?? err.message) : String(err);
	process.stderr.write(`uncaughtException: ${text}\n`);
	logAppEvent({ kind: 'fatal_error', message: `uncaughtException: ${text}` });
	// Matches Node's own guidance: don't keep serving after a truly uncaught
	// exception, state may be inconsistent.
	process.exit(1);
});
process.on('unhandledRejection', (reason) => {
	const text = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
	process.stderr.write(`unhandledRejection: ${text}\n`);
	logAppEvent({ kind: 'fatal_error', message: `unhandledRejection: ${text}` });
});

const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
// '[::1]' (bracketed), not '::1' — confirmed against Node's own URL parser:
// the WHATWG URL spec's .hostname keeps the brackets on an IPv6 literal, so
// a bare '::1' here never matched a real request/Origin using that address.
// Latent since this constant's introduction, surfaced while fixing the
// localhost/127.0.0.1 mismatch below — same class of bug, same fix.
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * Same-origin check for a loopback-only server, deliberately NOT a byte-exact
 * compare against event.url.origin. Two separate things make the exact
 * compare wrong here:
 *
 * 1. Protocol. adapter-node synthesizes the request URL's protocol as
 *    'https' whenever neither ORIGIN nor PROTOCOL_HEADER is set — its
 *    files/handler.js get_origin() ends in `|| 'https'` — and the Tauri
 *    sidecar sets neither (src-tauri/src/lib.rs spawns node with HOST, PORT,
 *    DATA_DIR, … only). So in any production build event.url.origin is
 *    `https://127.0.0.1:PORT` while the webview correctly sends
 *    `Origin: http://127.0.0.1:PORT`: every browser POST mismatches, on every
 *    machine. Verified against a real `node build` run — an `https://` Origin
 *    passed where the correct `http://` one was rejected. This is why file
 *    import 403'd in the installed app but never under `npm run dev`, where
 *    vite computes the origin correctly.
 * 2. Hostname spelling. 127.0.0.1 / localhost / [::1] all name this machine,
 *    and the hostname allowlist above already treats them as equivalent.
 *
 * Hence: port must match, hostname must be in the loopback allowlist,
 * protocol is ignored. Ignoring the protocol costs nothing in this threat
 * model — an `https://127.0.0.1:<same port>` origin would require a TLS
 * server on the very port this plain-HTTP server already occupies. A real
 * cross-site Origin (http://evil.example) is still rejected: its hostname is
 * never in LOOPBACK_HOSTNAMES.
 */
function isSameLoopbackOrigin(origin: string, url: URL): boolean {
	let originUrl: URL;
	try {
		originUrl = new URL(origin);
	} catch {
		return false;
	}
	return originUrl.port === url.port && LOOPBACK_HOSTNAMES.has(originUrl.hostname);
}

/**
 * Güvenlik sertleştirme — read once, at module load, not per request. Unlike
 * this module's other env-derived values, VC_SESSION_TOKEN cannot change for
 * the life of this process: Rust generates it once and sets it before
 * spawning the sidecar, never afterwards (see env.ts's sessionToken() for
 * the full contract and why it's still a function there). Re-reading
 * process.env on every single request — including every static asset —
 * would be pure waste for a value that is, by construction, immutable this
 * run. `undefined` here (plain `npm run dev`, `npm test`, MCP) means the
 * whole gate below is skipped, byte-for-byte the same as before this
 * feature existed.
 */
const SESSION_TOKEN = sessionToken();
const SESSION_COOKIE = 'vc_session';

/**
 * Flood guard for the 'security_block' app-log entries below — see
 * app-log.ts's own doc comment on that kind. A port scanner or a curious
 * neighbor process hammering this loopback server with bad Origins/Hosts/
 * tokens would otherwise write one line per rejected request forever;
 * app-log.jsonl already rotates at MAX_BYTES (app-log.ts), but rotation
 * alone still lets a flood churn through rotations and bury any OTHER
 * signal that landed in the same window. A plain fixed-window counter (not
 * a sliding one) is enough here — this is a courtesy cap on noise, not a
 * security control in itself; the requests are still rejected either way.
 */
const SECURITY_BLOCK_LOG_CAP = 20;
const SECURITY_BLOCK_LOG_WINDOW_MS = 60_000;
let securityBlockWindowStart = 0;
let securityBlockCountInWindow = 0;

/**
 * Logs one hooks.server.ts rejection to app-log.jsonl, rate-capped. Metadata
 * only, per app-log.ts's content rule: the stable `code`, the method, the
 * pathname WITHOUT its query string (a vc_session token, if one were ever
 * mistakenly appended by a caller, lives exactly there), and whichever of
 * Origin/Host named where the request claimed to come from. Never the
 * token, never a cookie/header value, never the full URL.
 */
function logSecurityBlock(code: string, event: RequestEvent): void {
	const now = Date.now();
	if (now - securityBlockWindowStart >= SECURITY_BLOCK_LOG_WINDOW_MS) {
		securityBlockWindowStart = now;
		securityBlockCountInWindow = 0;
	}
	securityBlockCountInWindow += 1;
	if (securityBlockCountInWindow > SECURITY_BLOCK_LOG_CAP) return;

	logAppEvent({
		kind: 'security_block',
		code,
		method: event.request.method,
		path: event.url.pathname,
		origin: event.request.headers.get('origin') ?? event.request.headers.get('host') ?? undefined,
		message: `security_block: ${code}`
	});
}

/**
 * This app has no auth layer at all — every /api/** route trusts whoever can
 * reach it, on the assumption that "reach it" means the local machine's own
 * user. That assumption breaks two ways a browser can hit it without the
 * user asking to:
 *
 * 1. DNS rebinding. A page at http://evil.example first resolves normally,
 *    then its DNS record is changed to 127.0.0.1; a script on that page can
 *    then fetch() paths on "evil.example" and have them land on THIS
 *    server. SvelteKit's own CSRF check (is_form_content_type + Origin,
 *    respond.js) does not catch this — it is also compiled out entirely in
 *    dev (`if (!__SVELTEKIT_DEV__)`), which is the mode this app runs in
 *    almost always. Host reflects the URL the browser THINKS it is
 *    fetching, not where the TCP connection actually landed, so a rebound
 *    request still carries `Host: evil.example` — checking event.url.hostname
 *    (built from Host, verified: no ORIGIN/HOST_HEADER override is set
 *    anywhere in this app) against a loopback allowlist catches it
 *    regardless of which host header the attacker's page used, and unlike
 *    SvelteKit's own check this runs in dev too and covers GET as well
 *    (rebinding is a read/exfiltration attack first — /api/chats/[id],
 *    /api/library/file — not just a state-changing one).
 * 2. Cross-site form/fetch submissions. Kept as a second, narrower check on
 *    top of SvelteKit's own (not instead of it) for the same dev-mode gap:
 *    an Origin header that disagrees with our own origin means the request
 *    was not initiated by a page this app served, regardless of content
 *    type. No Origin at all (curl, MCP, server-to-server) is let through —
 *    same posture SvelteKit's own csrf_check_origin takes.
 *
 * Güvenlik sertleştirme adds a THIRD check, after the loopback Host check
 * above: the packaged desktop build's per-launch session token (see
 * session-gate.ts and env.ts's sessionToken()). LOCAL_ONLY/CROSS_SITE_BLOCKED
 * defend against a browser being tricked into reaching this server at all;
 * the session token defends against something that already legitimately
 * reached it — another local process or user account on the same machine —
 * being trusted just because it's loopback. Skipped entirely when no token
 * is configured (plain `npm run dev`, `npm test`, MCP), so this is strictly
 * additive: nothing about the two checks above changes.
 *
 * Applied to EVERY request, not just page navigations/API calls — deliberately
 * including GET and static assets under /_app/. Two reasons this is the
 * right call rather than an allowlisted exemption:
 * 1. The cookie is cheap and present on every request from the SAME webview
 *    that a real user is using: after the one-time redirect below, the
 *    browser attaches `vc_session` automatically to literally everything it
 *    fetches for this origin, assets included. Exempting assets buys no
 *    real performance and only adds a route allowlist to keep in sync.
 * 2. Exempting /_app/ would hand an unauthenticated local process a working
 *    probe: it could fetch a known immutable asset path with no token at
 *    all and get a 200 (revealing the build exists, and on a Vite build,
 *    its content-hashed filenames) where every other path 401s. Checking
 *    everything uniformly means "no valid session" looks the same
 *    everywhere.
 */
export const handle: Handle = async ({ event, resolve }) => {
	if (!LOOPBACK_HOSTNAMES.has(event.url.hostname)) {
		logSecurityBlock('LOCAL_ONLY', event);
		error(403, { message: 'LOCAL_ONLY', code: 'LOCAL_ONLY' });
	}

	if (SESSION_TOKEN) {
		const decision = decideSessionGate({
			token: SESSION_TOKEN,
			queryToken: event.url.searchParams.get('vc_session'),
			cookieToken: event.cookies.get(SESSION_COOKIE) ?? null,
			headerToken: event.request.headers.get('x-vc-session'),
			pathname: event.url.pathname,
			searchParams: event.url.searchParams
		});

		if (decision.kind === 'redirect') {
			// Session cookie: httpOnly (never readable by page JS — this app has
			// no legitimate reason for client code to see the token), sameSite
			// 'lax', NOT 'strict': the first navigation comes from the splash
			// page on the tauri:// origin, i.e. cross-site, and a browser never
			// sends a Strict cookie on any hop of a cross-site-initiated
			// navigation chain — so the 303 below landed on `/` WITHOUT the
			// cookie it had just set and every packaged launch 401'd (seen live
			// 2026-09-28, app-log.jsonl: SESSION_REQUIRED on GET / right after
			// each spawn). Lax is still withheld on cross-site subresource and
			// POST requests, CROSS_SITE_BLOCKED below still guards state-changing
			// methods, and the cookie lives only in the app's own WebView2
			// profile — no other browser ever holds it. secure: false (this server is
			// plain http:// on loopback — 'secure' cookies are dropped outright
			// over http), no maxAge/expires so it's a SESSION cookie, gone the
			// moment the webview process ends, matching the token's own lifetime
			// (a fresh one is minted every launch).
			event.cookies.set(SESSION_COOKIE, SESSION_TOKEN, {
				path: '/',
				httpOnly: true,
				sameSite: 'lax',
				secure: false
			});
			redirect(303, decision.location);
		}

		if (decision.kind === 'reject') {
			logSecurityBlock('SESSION_REQUIRED', event);
			error(401, { message: 'SESSION_REQUIRED', code: 'SESSION_REQUIRED' });
		}
	}

	if (STATE_CHANGING_METHODS.has(event.request.method)) {
		const origin = event.request.headers.get('origin');
		if (origin && !isSameLoopbackOrigin(origin, event.url)) {
			logSecurityBlock('CROSS_SITE_BLOCKED', event);
			error(403, { message: 'CROSS_SITE_BLOCKED', code: 'CROSS_SITE_BLOCKED' });
		}
	}

	return resolve(event);
};

/**
 * Phase 1 (hardening) — the last-resort catch for anything that reaches
 * SvelteKit's own error boundary uncaught: an unhandled exception in
 * load()/an endpoint, or a 404 for a route that doesn't exist. Whatever this
 * returns becomes `page.error` on the root +error.svelte (see
 * src/app.d.ts's App.Error) — always a stable code, never the raw
 * exception's own (Turkish, unlocalized, possibly sensitive) message.
 *
 * 404s are routine navigation, not a bug — logging every one would just
 * noise up app-log.jsonl for e.g. browser favicon probes. Everything else is
 * a real failure and gets logged the same way uncaughtException above does.
 */
export const handleError: HandleServerError = ({ error: err, status }) => {
	if (status === 404) {
		return { message: 'ROUTE_NOT_FOUND', code: 'ROUTE_NOT_FOUND' };
	}

	const text = err instanceof Error ? (err.stack ?? err.message) : String(err);
	logAppEvent({ kind: 'fatal_error', message: `handleError: ${text}` });
	return { message: 'INTERNAL', code: 'INTERNAL' };
};
