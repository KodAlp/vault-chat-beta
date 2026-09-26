import { error, type Handle, type HandleServerError } from '@sveltejs/kit';
import { runVaultMigrationIfNeeded } from '$lib/server/migrateVaults';
import { logAppEvent } from '$lib/server/app-log';

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
 */
export const handle: Handle = async ({ event, resolve }) => {
	if (!LOOPBACK_HOSTNAMES.has(event.url.hostname)) {
		error(403, { message: 'LOCAL_ONLY', code: 'LOCAL_ONLY' });
	}

	if (STATE_CHANGING_METHODS.has(event.request.method)) {
		const origin = event.request.headers.get('origin');
		if (origin && !isSameLoopbackOrigin(origin, event.url)) {
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
