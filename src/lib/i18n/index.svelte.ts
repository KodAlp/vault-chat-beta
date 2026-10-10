import tr from './messages/tr.json';
import en from './messages/en.json';
import { DEFAULT_LOCALE, localeInfo, migrateLocale, type Locale } from './locales';
import { resolveMessage, type MessageTree } from './resolve';

export type { Locale } from './locales';

/**
 * Faz 19 — i18n scaffolding. This app was built Turkish-only from Faz 1
 * (every string hardcoded inline, see any *.svelte file's template); this
 * module is the seam that lets a locale be a runtime choice instead. No
 * library (no paraglide/i18next/svelte-i18n) — a component list + one
 * JSON file per locale + a small lookup is enough for this app's scale,
 * and skips a dependency the eventual Tauri desktop build would otherwise
 * carry for its whole lifetime.
 *
 * Keys are "Component.field" (e.g. `t('Chat.send')`), namespaced by the
 * .svelte file the string lives in. A handful of strings that appear
 * verbatim in many components (Sil/Vazgeç/Kapat/İptal/Ayarlar/"Klasörde
 * aç"/generic error fallbacks) live under the pseudo-component "Common"
 * instead of being duplicated N times — still namespaced, just shared
 * namespace, same lookup mechanics.
 *
 * The language list itself lives in locales.ts (also imported server-side,
 * so the persisted-pref validator and the picker can never disagree).
 *
 * Catalogs: tr.json and en.json are statically imported — tr is the app's
 * origin language and the last-resort fallback, en is the fallback every
 * other language leans on, and both must be available synchronously for the
 * very first paint. Every other messages/<code>.json is pulled in on demand
 * through a non-eager import.meta.glob, so Vite splits each into its own
 * chunk and a user who never leaves tr/en never downloads the other 14.
 * Loaded catalogs live in a $state.raw map that is REPLACED (not mutated)
 * on load: t() reads it, so every t() call site re-renders when a catalog
 * arrives, and .raw avoids wrapping thousands of strings in deep proxies.
 *
 * Resolution (see resolve.ts for the pure logic and its tests): current
 * locale -> its parent (ar-EG -> ar, pcm -> en) -> en -> tr -> the raw key.
 * en before tr because en.json is now complete and is the more useful
 * language for a foreign reader; tr stays as the last resort so a key only
 * ever added to tr.json still shows real text instead of its name. A gap
 * that survives all four shows the raw key, visibly debuggable instead of
 * silently empty.
 *
 * Plurals: a catalog may carry sibling keys `field#one`, `field#few`, ...
 * next to the base `field` (= the "other" form). When params has a numeric
 * `count`, t() asks Intl.PluralRules for the category and prefers the
 * matching variant — see resolve.ts.
 */

const lazyCatalogs = import.meta.glob<MessageTree>(['./messages/*.json', '!./messages/tr.json', '!./messages/en.json'], {
	import: 'default'
});

/** $state.raw + reassignment (never in-place mutation): see the header. */
let catalogs = $state.raw<Record<string, MessageTree>>({ tr: tr as MessageTree, en: en as MessageTree });
const inflight = new Map<string, Promise<boolean>>();

/** Exported so +layout.ts's migration check can tell "nothing in
 * localStorage yet" apart from "loadInitial() already read it" without
 * duplicating the literal string. */
export const STORAGE_KEY = 'vault-chat-locale';

function loadInitial(): Locale {
	if (typeof localStorage === 'undefined') return DEFAULT_LOCALE;
	try {
		return migrateLocale(localStorage.getItem(STORAGE_KEY)) ?? DEFAULT_LOCALE;
	} catch {
		return DEFAULT_LOCALE;
	}
}

/** Module-level $state, same pattern as settings.svelte.ts — a client
 * device preference, not conversation data. `loading` is the locale whose
 * catalog is currently being fetched (the picker shows a subtle spinner). */
export const i18n = $state<{ locale: Locale; loading: Locale | null }>({ locale: loadInitial(), loading: null });

/** Loads one catalog (idempotent, deduplicated). Resolves false when the
 * file doesn't exist or fails to load — callers decide the fallback. */
function loadCatalog(code: Locale): Promise<boolean> {
	if (catalogs[code]) return Promise.resolve(true);
	const existing = inflight.get(code);
	if (existing) return existing;
	const loader = lazyCatalogs[`./messages/${code}.json`];
	if (!loader) {
		console.warn(`i18n: no catalog file for "${code}", falling back to en`);
		return Promise.resolve(false);
	}
	const p = loader().then(
		(tree) => {
			catalogs = { ...catalogs, [code]: tree };
			inflight.delete(code);
			return true;
		},
		(err) => {
			inflight.delete(code);
			console.warn(`i18n: failed to load catalog "${code}", falling back to en`, err);
			return false;
		}
	);
	inflight.set(code, p);
	return p;
}

/** Loads a locale's catalog plus its parent's (the fallback chain reads both).
 * Returns whether the locale itself is usable; a missing parent is tolerated
 * since t() still has en/tr below it. */
export async function ensureLocaleLoaded(code: Locale): Promise<boolean> {
	const parent = localeInfo(code).parent;
	const [ok] = await Promise.all([loadCatalog(code), parent ? loadCatalog(parent) : Promise.resolve(true)]);
	return ok;
}

// A locale restored from localStorage at module init has no catalog yet;
// start fetching immediately so t() falls back to en only for a moment even
// when +layout.ts's server round-trip fails or is slow.
if (typeof window !== 'undefined' && i18n.locale !== 'tr' && i18n.locale !== 'en') {
	void ensureLocaleLoaded(i18n.locale);
}

/** Latest-wins guard: two quick picks must not let the slower load of the
 * first overwrite the second. */
let switchToken = 0;

async function switchTo(code: Locale): Promise<Locale> {
	const token = ++switchToken;
	i18n.loading = code;
	const ok = await ensureLocaleLoaded(code);
	if (token !== switchToken) return i18n.locale;
	i18n.loading = null;
	i18n.locale = ok ? code : 'en';
	return i18n.locale;
}

export function persistLocale(): void {
	if (typeof localStorage === 'undefined') return;
	try {
		localStorage.setItem(STORAGE_KEY, i18n.locale);
	} catch {
		// Private window / blocked storage: the server copy below still works.
	}
	// Fire-and-forget: the server-side copy (ui-prefs-store.ts) is what
	// survives the Tauri desktop build's random sidecar port, but a failed
	// PUT here just means this pick won't survive the next launch — not
	// worth blocking or surfacing to the user over.
	if (typeof window !== 'undefined') {
		fetch('/api/ui-prefs', {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ locale: i18n.locale })
		}).catch((err) => console.warn('ui-prefs locale PUT failed', err));
	}
}

/** User-initiated switch: loads the catalog first so the UI flips in one
 * step (no flash of raw keys / wrong language), then persists. If the
 * catalog can't be loaded the locale becomes en (and en is what's saved). */
export async function setLocale(code: Locale): Promise<void> {
	await switchTo(code);
	persistLocale();
}

/** Applied from +layout.ts's load with the server-persisted copy — validated
 * the same way loadInitial() validates localStorage, since this is untrusted
 * network data (the server already sanitizes it too, but never trust twice
 * removed). Async because +layout.ts awaits it: the first paint must already
 * be in the right language. Doesn't persist — it is restoring, not choosing. */
export async function applyLocale(locale: unknown): Promise<void> {
	const resolved = migrateLocale(locale);
	if (resolved) await switchTo(resolved);
}

/**
 * `t('Component.key', params?)`. Fallback chain and plural handling are
 * documented in the header and implemented in resolve.ts. `params` does
 * simple `{name}` substitution for the handful of strings that carry dynamic
 * values (e.g. a filename, a count) — see tr.json entries containing `{...}`.
 */
export function t(key: string, params?: Record<string, string | number>): string {
	const code = i18n.locale;
	const parent = localeInfo(code).parent;
	return resolveMessage(
		[
			[code, catalogs[code]],
			...(parent ? ([[parent, catalogs[parent]]] as const) : []),
			['en', catalogs.en],
			['tr', catalogs.tr]
		],
		key,
		params
	);
}
