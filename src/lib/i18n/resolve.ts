/**
 * Pure message resolution, split out of index.svelte.ts so the fallback chain
 * and plural selection can be unit-tested with plain `tsx --test` (the rune
 * module can't be imported there). index.svelte.ts owns the reactive state;
 * this file only answers "given these catalogs, what string?".
 */

import { intlLocale } from './locales';

export type MessageTree = Record<string, Record<string, string>>;

/** en.json historically marked an untranslated key with this value; t() treats
 * it like a missing key. Kept because an empty string is indistinguishable from
 * "translated to nothing", which would silently blank a button. */
const EMPTY_MARKER = '';

function nonEmpty(v: string | undefined): string | undefined {
	return v && v !== EMPTY_MARKER ? v : undefined;
}

const PLURAL_CACHE = new Map<string, Intl.PluralRules>();

/** Cached per locale: constructing PluralRules is comparatively expensive and
 * t() runs on every render. Locales Intl doesn't know (pcm in older engines)
 * fall back to English rules rather than throwing mid-render. */
export function pluralCategory(locale: string, count: number): Intl.LDMLPluralRule {
	let rules = PLURAL_CACHE.get(locale);
	if (!rules) {
		try {
			rules = new Intl.PluralRules(intlLocale(locale));
		} catch {
			rules = new Intl.PluralRules('en');
		}
		PLURAL_CACHE.set(locale, rules);
	}
	return rules.select(count);
}

/**
 * Resolve `Component.field` against an ordered chain of [localeCode, catalog]
 * pairs (most specific first). Plural: when params.count is a number, a sibling
 * `field#<category>` is preferred, but only from the SAME catalog that supplies
 * the base — mixing a Russian "few" form with an English base would produce a
 * half-translated sentence, so each catalog is consulted as a unit.
 */
export function resolveMessage(
	chain: ReadonlyArray<readonly [string, MessageTree | undefined]>,
	key: string,
	params?: Record<string, string | number>
): string {
	const dot = key.indexOf('.');
	const component = dot === -1 ? key : key.slice(0, dot);
	const field = dot === -1 ? '' : key.slice(dot + 1);

	let resolved: string | undefined;
	for (const [code, tree] of chain) {
		const block = tree?.[component];
		if (!block) continue;
		const base = nonEmpty(block[field]);
		let variant: string | undefined;
		if (params && typeof params.count === 'number' && Number.isFinite(params.count)) {
			variant = nonEmpty(block[`${field}#${pluralCategory(code, params.count)}`]);
		}
		resolved = variant ?? base;
		if (resolved !== undefined) break;
	}
	resolved ??= key;

	if (!params) return resolved;
	return resolved.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match));
}
