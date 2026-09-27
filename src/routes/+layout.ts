import type { LayoutLoad } from './$types';
import { applyLocale, persistLocale, STORAGE_KEY as LOCALE_STORAGE_KEY } from '$lib/i18n/index.svelte';
import { applySettings, persistSettings, STORAGE_KEY as SETTINGS_STORAGE_KEY } from '$lib/settings.svelte';

// markdown.ts uses the browser build of DOMPurify (needs `window`); no SSR benefit
// for a local-only app, so keep this off everywhere rather than add jsdom.
export const ssr = false;

/**
 * Desktop launches spawn the sidecar with a random port (PORT=0 — see
 * src-tauri/src/lib.rs's spawn_sidecar), so the webview's origin changes on
 * every launch and localStorage starts empty every time; see
 * ui-prefs-store.ts's doc comment for the full picture. This pulls the
 * server's DATA_DIR-persisted copy of locale/settings back in on every load
 * so a relaunch doesn't silently reset the user's language/theme/model
 * picks back to their compiled-in defaults.
 *
 * One-time migration for plain `npm run dev` in a browser: if the server has
 * NEITHER a locale NOR any settings saved yet (a fresh DATA_DIR, or an
 * install from before this endpoint existed) but localStorage already has
 * real values, push them up once so the next load — desktop or browser —
 * has something to read. A genuinely fresh profile with nothing in
 * localStorage either just keeps this module's own compiled-in defaults, as
 * before.
 *
 * Any failure (server not reachable yet, bad JSON, whatever) is swallowed —
 * this is a nice-to-have on top of localStorage/defaults, never something
 * worth blocking navigation over.
 */
export const load: LayoutLoad = async ({ fetch }) => {
	try {
		const res = await fetch('/api/ui-prefs');
		if (!res.ok) return {};
		const prefs = (await res.json()) as { locale?: unknown; settings?: Record<string, unknown> };

		if (prefs.locale !== undefined) applyLocale(prefs.locale);
		if (prefs.settings !== undefined) applySettings(prefs.settings);

		if (
			prefs.locale === undefined &&
			prefs.settings === undefined &&
			typeof localStorage !== 'undefined' &&
			(localStorage.getItem(LOCALE_STORAGE_KEY) !== null || localStorage.getItem(SETTINGS_STORAGE_KEY) !== null)
		) {
			persistLocale();
			persistSettings();
		}
	} catch (err) {
		console.warn('ui-prefs load failed', err);
	}
	return {};
};
