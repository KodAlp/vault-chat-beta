import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from './env';
import type { Settings } from '$lib/settings.svelte';

/**
 * Desktop launches spawn the Node sidecar with PORT=0 (src-tauri/src/lib.rs's
 * spawn_sidecar picks the port so the OS assigns a genuinely free one at
 * bind time) — which means the webview's origin (http://127.0.0.1:<port>) is
 * different on every launch, and localStorage is scoped per-origin. The
 * locale i18n/index.svelte.ts stores under 'vault-chat-locale' and the
 * Settings settings.svelte.ts stores under 'vault-chat-settings' therefore
 * silently reset to their compiled-in defaults every time the desktop app
 * restarts, even though the user picked a language/theme/model moments
 * earlier. This file is the fix: a small DATA_DIR-relative JSON file, keyed
 * off dataDir() the same way providers.json/secrets.json already are (see
 * env.ts), that survives across the random port. The client still writes
 * localStorage too (see persistLocale/persistSettings) — this is additive,
 * not a replacement, so plain `npm run dev` in a browser keeps working with
 * zero server round-trip mattering in the common case.
 *
 * `Settings` is imported with `import type` only — erased at compile time,
 * so it never actually pulls settings.svelte.ts's `$state` module into this
 * server module or into a plain `tsx --test` run of this file's own test.
 * Free of SvelteKit imports otherwise, same reasoning as provider-consent.ts.
 */

const FILE_NAME = 'ui-prefs.json';

export type UiPrefs = {
	locale?: 'tr' | 'en';
	settings?: Partial<Settings>;
	/**
	 * Aşama 2b — "has this install already been walked through
	 * /setup/local-server once?" Same random-sidecar-port problem as
	 * locale/settings above: a localStorage-only flag (see the original
	 * localServerSetup.ts) reset to unset on every desktop launch, which
	 * made the once-ever wizard reappear every single time. Top-level, not
	 * nested under `settings` — it isn't a user-facing preference the
	 * settings page edits, it's onboarding-completion state, same rank as
	 * `locale`.
	 */
	localServerSetupDone?: boolean;
};

const THEMES = new Set(['light', 'dark', 'cream', 'sand', 'forest', 'system']);
const MAX_STRING_LEN = 200;
const STRING_FIELDS = [
	'defaultModel',
	'fastModel',
	'reasoningModel',
	'defaultProvider',
	'fastProvider',
	'reasoningProvider'
] as const;
const BOOLEAN_FIELDS = ['allowConcurrentGeneration', 'showWelcomeScreen', 'quizLevelLabels'] as const;

function isNonEmptyShortString(v: unknown): v is string {
	return typeof v === 'string' && v.length > 0 && v.length <= MAX_STRING_LEN;
}

function sanitizeLocale(raw: unknown): 'tr' | 'en' | undefined {
	return raw === 'tr' || raw === 'en' ? raw : undefined;
}

/** Strict boolean only — anything else (a string "true", a number, null) is
 * dropped rather than coerced, same "wrong runtime shape never survives"
 * rule the settings BOOLEAN_FIELDS loop below already applies. */
function sanitizeBoolean(raw: unknown): boolean | undefined {
	return typeof raw === 'boolean' ? raw : undefined;
}

/** Drops any key that isn't a known Settings field with the right runtime
 * shape — this is fed from a PUT body (untrusted network data) and later
 * Object.assign'd straight into $state (see settings.svelte.ts's
 * applySettings), so a wrong type or an unknown key must never survive to
 * that point. */
function sanitizeSettings(raw: unknown): Partial<Settings> | undefined {
	if (typeof raw !== 'object' || raw === null) return undefined;
	const src = raw as Record<string, unknown>;
	const out: Partial<Settings> = {};

	if (typeof src.theme === 'string' && THEMES.has(src.theme)) {
		out.theme = src.theme as Settings['theme'];
	}
	if (src.motion === 'system' || src.motion === 'on' || src.motion === 'off') {
		out.motion = src.motion;
	}
	for (const key of STRING_FIELDS) {
		// Aşama 4c: '' is a real value here ("no model/provider chosen — use the task chain"), and it must
		// survive the merge in writeUiPrefs: dropping it would let an older saved pin (e.g. a provider that
		// was just deleted) come back on the next load instead of staying cleared.
		if (typeof src[key] === 'string' && (src[key] as string).length <= MAX_STRING_LEN) out[key] = src[key] as string;
	}
	for (const key of BOOLEAN_FIELDS) {
		if (typeof src[key] === 'boolean') out[key] = src[key] as boolean;
	}

	return Object.keys(out).length > 0 ? out : undefined;
}

function filePath(): string {
	return path.join(dataDir(), FILE_NAME);
}

/** Missing file (first launch, or a pre-existing install with none of this
 * yet) and a corrupt file are the same case: fall back to an empty prefs
 * object so the caller keeps using whatever it already has (localStorage or
 * compiled-in defaults), never throw. */
export function readUiPrefs(): UiPrefs {
	try {
		const raw = fs.readFileSync(filePath(), 'utf-8');
		const parsed = JSON.parse(raw) as { locale?: unknown; settings?: unknown; localServerSetupDone?: unknown };
		const out: UiPrefs = {};
		const locale = sanitizeLocale(parsed.locale);
		if (locale) out.locale = locale;
		const settings = sanitizeSettings(parsed.settings);
		if (settings) out.settings = settings;
		const localServerSetupDone = sanitizeBoolean(parsed.localServerSetupDone);
		if (localServerSetupDone !== undefined) out.localServerSetupDone = localServerSetupDone;
		return out;
	} catch {
		return {};
	}
}

/**
 * Merge, not replace: `locale` is a single value (last write wins), while
 * `settings` is shallow-merged field by field so a PUT that only changed
 * `theme` doesn't clobber a `defaultModel` some earlier PUT already saved —
 * matching how persistSettings() always sends the whole Settings object but
 * different call sites may race in either order.
 *
 * Atomic write (tmp file in the same directory, then fs.renameSync) so a
 * crash mid-write never leaves a half-written ui-prefs.json for the next
 * readUiPrefs() to choke on.
 */
export function writeUiPrefs(patch: UiPrefs): UiPrefs {
	const current = readUiPrefs();
	const locale = sanitizeLocale(patch.locale) ?? current.locale;
	const settingsPatch = sanitizeSettings(patch.settings);
	const mergedSettings =
		settingsPatch || current.settings ? { ...current.settings, ...settingsPatch } : undefined;
	// `??`, not `||` — sanitizeBoolean(patch...) can legitimately be `false`,
	// which must win over an existing `true`, not fall through to it the way
	// `||` would.
	const localServerSetupDone = sanitizeBoolean(patch.localServerSetupDone) ?? current.localServerSetupDone;

	const next: UiPrefs = {};
	if (locale) next.locale = locale;
	if (mergedSettings && Object.keys(mergedSettings).length > 0) next.settings = mergedSettings;
	if (localServerSetupDone !== undefined) next.localServerSetupDone = localServerSetupDone;

	const p = filePath();
	const tmp = `${p}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf-8');
	fs.renameSync(tmp, p);

	return next;
}
