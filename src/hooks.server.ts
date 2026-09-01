import { error, type Handle } from '@sveltejs/kit';
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
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1']);

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
		error(403, 'Bu sunucuya sadece yerel makineden erişilebilir.');
	}

	if (STATE_CHANGING_METHODS.has(event.request.method)) {
		const origin = event.request.headers.get('origin');
		if (origin && origin !== event.url.origin) {
			error(403, 'Cross-site istekler engellenir.');
		}
	}

	return resolve(event);
};
