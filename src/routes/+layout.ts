import type { LayoutLoad } from './$types';
import { applyLocale, ensureLocaleLoaded, i18n, persistLocale, STORAGE_KEY as LOCALE_STORAGE_KEY } from '$lib/i18n/index.svelte';
import { applySettings, persistSettings, settings, STORAGE_KEY as SETTINGS_STORAGE_KEY } from '$lib/settings.svelte';
import { stalePinPatch } from '$lib/settings-reconcile';
import { applyLocalServerSetupDone } from '$lib/localServerSetup.svelte';

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
		// Deliberately NOT returning early here for localServerSetup.svelte.ts's
		// sake: that module's `done` default is `true` (wizard skipped) until
		// this load either confirms a real value or fails outright — leaving
		// `!res.ok` an early `return {}` (as it was before) would mean a
		// non-OK response never applies anything, same as a thrown fetch, so
		// no behavior change there. It's the *success* path a few lines down
		// that must always call applyLocalServerSetupDone, even when the field
		// itself is absent (a fresh install) — see that function's doc comment.
		if (!res.ok) return {};
		const prefs = (await res.json()) as {
			locale?: unknown;
			settings?: Record<string, unknown>;
			localServerSetupDone?: unknown;
		};

		// Awaited: a lazily-loaded catalog must be in before the first paint, otherwise every string flashes in the fallback language.
		if (prefs.locale !== undefined) await applyLocale(prefs.locale);
		if (prefs.settings !== undefined) applySettings(prefs.settings);
		applyLocalServerSetupDone(prefs.localServerSetupDone);

		// Aşama 4c: a saved model/provider pin whose provider was deleted or disabled is cleared, so requests
		// carry no pin and the server falls back to the task chain (and that provider's own default model).
		try {
			const providersRes = await fetch('/api/providers');
			if (providersRes.ok) {
				const list = (await providersRes.json()) as { id: string; enabled: boolean }[];
				const patch = stalePinPatch(settings, new Set(list.filter((p) => p.enabled).map((p) => p.id)));
				if (Object.keys(patch).length > 0) {
					applySettings(patch);
					persistSettings();
				}
			}
		} catch {
			// Best-effort: a stale pin just keeps producing chat-fallback's "pin dropped" notice.
		}

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
	// Covers every path that skipped applyLocale (server unreachable, no saved locale): a localStorage-restored
	// non-tr/en locale still needs its catalog before first paint.
	await ensureLocaleLoaded(i18n.locale);
	return {};
};
