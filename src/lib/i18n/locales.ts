/**
 * Single source of truth for the UI languages. Plain TS on purpose (no runes,
 * no SvelteKit imports): the server-side ui-prefs-store validates the saved
 * locale against the same list the client picker renders, and a hand-copied
 * union in two places is exactly how a language ends up selectable but never
 * persisted. One catalog file per code lives at messages/<code>.json.
 *
 * Order is the picker order: the two languages with complete hand-maintained
 * catalogs first (tr, en), then the rest.
 *
 * `parent` is the regional-variant fallback: ar-EG catalogs only carry what
 * differs from Modern Standard Arabic, and Nigerian Pidgin leans on English
 * for anything untranslated (t() walks current -> parent -> en -> tr).
 */
export const LOCALES = [
	{ code: 'tr', nativeName: 'Türkçe', englishName: 'Turkish', dir: 'ltr' },
	{ code: 'en', nativeName: 'English', englishName: 'English', dir: 'ltr' },
	{ code: 'zh-CN', nativeName: '简体中文', englishName: 'Chinese (Simplified)', dir: 'ltr' },
	{ code: 'hi', nativeName: 'हिन्दी', englishName: 'Hindi', dir: 'ltr' },
	{ code: 'es', nativeName: 'Español', englishName: 'Spanish', dir: 'ltr' },
	{ code: 'ar', nativeName: 'العربية', englishName: 'Arabic', dir: 'rtl' },
	{ code: 'fr', nativeName: 'Français', englishName: 'French', dir: 'ltr' },
	{ code: 'bn', nativeName: 'বাংলা', englishName: 'Bengali', dir: 'ltr' },
	{ code: 'pt', nativeName: 'Português (Brasil)', englishName: 'Portuguese (Brazil)', dir: 'ltr' },
	{ code: 'id', nativeName: 'Bahasa Indonesia', englishName: 'Indonesian', dir: 'ltr' },
	{ code: 'ur', nativeName: 'اردو', englishName: 'Urdu', dir: 'rtl' },
	{ code: 'ru', nativeName: 'Русский', englishName: 'Russian', dir: 'ltr' },
	{ code: 'de', nativeName: 'Deutsch', englishName: 'German', dir: 'ltr' },
	{ code: 'ja', nativeName: '日本語', englishName: 'Japanese', dir: 'ltr' },
	{ code: 'pcm', nativeName: 'Naijá (Nigerian Pidgin)', englishName: 'Nigerian Pidgin', dir: 'ltr', parent: 'en' },
	{ code: 'ar-EG', nativeName: 'العربية (مصر)', englishName: 'Arabic (Egypt)', dir: 'rtl', parent: 'ar' }
] as const;

export type Locale = (typeof LOCALES)[number]['code'];

export type LocaleInfo = {
	code: Locale;
	nativeName: string;
	englishName: string;
	dir: 'ltr' | 'rtl';
	parent?: Locale;
};

export const DEFAULT_LOCALE: Locale = 'tr';

const BY_CODE = new Map<string, LocaleInfo>(LOCALES.map((l) => [l.code, l as LocaleInfo]));

export function isLocale(v: unknown): v is Locale {
	return typeof v === 'string' && BY_CODE.has(v);
}

/** The tag to hand to Intl.*. Intl silently falls back to the OS default
 * locale for a tag the engine has no data for (pcm on an older WebView2 ICU),
 * which would mix e.g. German dates into a Naijá UI; resolve to the parent or
 * en instead. */
export function intlLocale(code: string): string {
	const candidates = [code, BY_CODE.get(code)?.parent, 'en'];
	for (const c of candidates) {
		if (!c) continue;
		try {
			if (Intl.DateTimeFormat.supportedLocalesOf(c).length > 0) return c;
		} catch {
			// malformed tag: try the next candidate
		}
	}
	return 'en';
}

/** Falls back to the default locale's info for anything unknown, so callers
 * (the layout's lang/dir effect) never have to null-check. */
export function localeInfo(code: string): LocaleInfo {
	return BY_CODE.get(code) ?? (BY_CODE.get(DEFAULT_LOCALE) as LocaleInfo);
}
