const STORAGE_KEY = 'vault-chat-local-server-setup-done';

/**
 * Aşama 2b — "has this install already been walked through
 * /setup/local-server once?"
 *
 * Revised after review: this used to be a plain localStorage flag, exactly
 * like the original (pre-Faz-19) locale/settings storage. That's broken for
 * the same reason ui-prefs-store.ts's doc comment already documents for
 * those: the Tauri desktop build spawns the Node sidecar with PORT=0, so
 * the webview's origin (and therefore localStorage) is different on EVERY
 * launch — a localStorage-only flag would reset on every relaunch and the
 * once-ever wizard would reappear every single time. This module now
 * mirrors i18n/index.svelte.ts's pattern instead: an in-memory `$state`
 * populated at layout-load time from the server-persisted copy
 * (ui-prefs.json's `localServerSetupDone` field, read through
 * GET/PUT /api/ui-prefs — see +layout.ts's `load` and `markLocalServerSetupDone`
 * below), which survives the random port because it lives in DATA_DIR, not
 * in the webview's per-origin storage. localStorage is still written as a
 * same-session belt-and-suspenders (same reasoning persistLocale() uses),
 * but it is never read back — the server value is the only source of truth.
 *
 * Defaults to `true` (wizard skipped) until +layout.ts's load either
 * confirms a fresh install's flag is genuinely unset (then
 * applyLocalServerSetupDone(false) below) or fails outright (network
 * error, corrupt file) — in the failure case this module's `true` default
 * is exactly what stops a user from ever being trapped in the wizard with
 * no way to reach the very endpoint that would clear it.
 */
let done = $state(true);

export function localServerSetupDone(): boolean {
	return done;
}

/**
 * Called only from +layout.ts's load, with the raw (already-JSON-parsed)
 * `localServerSetupDone` field from GET /api/ui-prefs's response. `true`
 * only for a literal `true` — a missing field (fresh install), a literal
 * `false`, or any other stray value all become `false` here, so a
 * genuinely fresh install's unset flag reliably shows the wizard exactly
 * once, the same way sanitizeBoolean() on the server side only ever trusts
 * an actual boolean.
 */
export function applyLocalServerSetupDone(raw: unknown): void {
	done = raw === true;
}

/**
 * Marks the wizard done: flips the in-memory flag immediately (so this
 * session never shows it again) and persists it server-side so the NEXT
 * launch — a fresh webview origin, a fresh in-memory `done` default of
 * `true` here — reads back a real `true` from ui-prefs.json instead of
 * falling through to that default only by coincidence. The PUT is
 * fire-and-forget, same as persistLocale()'s: a failed write here just
 * means this one pick won't survive the next launch, not worth blocking or
 * surfacing to the user over (and the `true` default means it fails safe
 * either way — see the module doc comment).
 */
export function markLocalServerSetupDone(): void {
	done = true;
	if (typeof localStorage !== 'undefined') {
		try {
			localStorage.setItem(STORAGE_KEY, '1');
		} catch {
			// Best-effort only — see the module doc comment.
		}
	}
	if (typeof window !== 'undefined') {
		fetch('/api/ui-prefs', {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ localServerSetupDone: true })
		}).catch((err) => console.warn('ui-prefs localServerSetupDone PUT failed', err));
	}
}
