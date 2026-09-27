import tr from './messages/tr.json';
import en from './messages/en.json';

export type Locale = 'tr' | 'en';

/**
 * Faz 19 — i18n scaffolding. This app was built Turkish-only from Faz 1
 * (every string hardcoded inline, see any *.svelte file's template); this
 * module is the seam that lets a locale be a runtime choice instead. No
 * library (no paraglide/i18next/svelte-i18n) — a component list + one
 * JSON file per locale + a ~40-line lookup is enough for this app's scale,
 * and skips a dependency the eventual Tauri desktop build would otherwise
 * carry for its whole lifetime.
 *
 * Keys are "Component.field" (e.g. `t('Chat.send')`), namespaced by the
 * .svelte file the string lives in — mirrors the exact grouping asked for
 * ("Component adı { key = value }"). A handful of strings that appear
 * verbatim in many components (Sil/Vazgeç/Kapat/İptal/Ayarlar/"Obsidian'da
 * aç"/generic error fallbacks) live under the pseudo-component "Common"
 * instead of being duplicated N times — still namespaced, just shared
 * namespace, same lookup mechanics.
 *
 * tr.json is the complete, authoritative inventory (every user-visible
 * string this app has, as of Faz 19) — filled in for every component,
 * whether or not that component has been wired to call t() yet. en.json
 * mirrors every key tr.json has, but intentionally starts empty for keys
 * nobody has translated yet (see EMPTY_MARKER below) — this is the
 * "file structure now, languages added incrementally" split the user
 * asked for. A handful of components (the main chat screen: Chat,
 * Message, the five generation dialogs, StudyPanel, SourceTree, ...) are
 * already wired to call t() as a proven, working template; the rest are
 * inventoried in tr.json but still read their Turkish text as a literal
 * string in the template — converting one of those is: replace the
 * literal with `t('ComponentName.newKey')`, add "newKey" under
 * "ComponentName" in both JSON files.
 */

type MessageTree = Record<string, Record<string, string>>;

const MESSAGES: Record<Locale, MessageTree> = { tr: tr as MessageTree, en: en as MessageTree };

/** en.json marks a not-yet-translated key with this exact string rather
 * than an empty "" — an empty string is indistinguishable from "someone
 * translated it to nothing", which would silently swallow a button label.
 * t() treats EMPTY_MARKER the same as a missing key (falls through to tr). */
const EMPTY_MARKER = '';

const FALLBACK_LOCALE: Locale = 'tr';
/** Exported so +layout.ts's migration check can tell "nothing in
 * localStorage yet" apart from "loadInitial() already read it" without
 * duplicating the literal string. */
export const STORAGE_KEY = 'vault-chat-locale';

function isLocale(v: string | null): v is Locale {
	return v === 'tr' || v === 'en';
}

function loadInitial(): Locale {
	if (typeof localStorage === 'undefined') return FALLBACK_LOCALE;
	const raw = localStorage.getItem(STORAGE_KEY);
	return isLocale(raw) ? raw : FALLBACK_LOCALE;
}

/** Module-level $state, same pattern as settings.svelte.ts — a client
 * device preference, not conversation data. */
export const i18n = $state<{ locale: Locale }>({ locale: loadInitial() });

export function persistLocale(): void {
	if (typeof localStorage === 'undefined') return;
	localStorage.setItem(STORAGE_KEY, i18n.locale);
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

/** Applied from +layout.ts's load with the server-persisted copy — validated
 * the same way loadInitial() validates localStorage, since this is untrusted
 * network data (the server already sanitizes it too, but never trust twice
 * removed). */
export function applyLocale(locale: unknown): void {
	if (typeof locale === 'string' && isLocale(locale)) {
		i18n.locale = locale;
	}
}

/**
 * `t('Component.key', params?)`. Resolution order: current locale ->
 * FALLBACK_LOCALE (tr, never en — en.json is an intentionally incomplete
 * skeleton, falling back to IT would show blank buttons) -> the raw key
 * itself, so a translation gap is visibly a raw key in the UI (debuggable)
 * rather than silently empty. `params` does simple `{name}` substitution
 * for the handful of strings that carry dynamic values (e.g. a filename,
 * a count) — see tr.json entries containing `{...}` placeholders.
 */
export function t(key: string, params?: Record<string, string | number>): string {
	const dot = key.indexOf('.');
	const component = dot === -1 ? key : key.slice(0, dot);
	const field = dot === -1 ? '' : key.slice(dot + 1);

	const resolved =
		nonEmpty(MESSAGES[i18n.locale]?.[component]?.[field]) ??
		nonEmpty(MESSAGES[FALLBACK_LOCALE]?.[component]?.[field]) ??
		key;

	if (!params) return resolved;
	return resolved.replace(/\{(\w+)\}/g, (match, name: string) =>
		name in params ? String(params[name]) : match
	);
}

function nonEmpty(v: string | undefined): string | undefined {
	return v && v !== EMPTY_MARKER ? v : undefined;
}
