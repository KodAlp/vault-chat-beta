/**
 * Decides which language the model should answer in for a single chat turn — lifted verbatim
 * (V4's decision function, see scripts/eval-response-language.ts's doc comment for the full
 * measurement history) from that eval script into product code. Pure: no $env/$lib runtime
 * dependency, no DB, no fetch — just franc-min (already a dependency) and Intl.DisplayNames.
 *
 * The bug this fixes: coreIntro() in prompt.ts used to hardcode "Her zaman Türkçe dilinde cevap
 * ver.", so an English question got a Turkish answer regardless of what the user actually wrote.
 * Measured against qwen3:8b on a 30-case battery (scripts/eval-response-language.ts), this
 * function's "V4" strategy scored 90/90 vs. ~57% for the old fixed-language behavior (V0).
 *
 * Only ever called on the LAST user message (never retrieved context, which is always English
 * regardless of the user's language and would otherwise contaminate the signal) plus this
 * conversation's earlier user turns (for the narrowed-candidate-set tier below). Historical turns
 * are never retagged — only the final message gets a directive appended (see prompt.ts's
 * coreIntro/buildPromptMessages).
 */
import { francAll } from 'franc-min';
import { data as francData } from 'franc-min/data.js';
import { expressions } from 'franc-min/expressions.js';

// --- Reliability gate (calibrated against franc-min directly — see the eval script's doc
// comment for the calibration story). A handful of toy sentences and a dry run over the eval
// battery showed franc-min's trigram model genuinely struggles on short/informal technical text:
// full English/Turkish/German knowledge questions sometimes lose to an unrelated language by a
// small margin, and at least one Turkish slang message ("abi b-tree nasıl çalışıyo ya")
// confidently (margin 0.125) misclassified as Lingala. MIN_LETTERS=20 and MARGIN_THRESHOLD=0.15
// were chosen as the smallest margin that still rejected that specific false positive while
// keeping most real knowledge-question detections — not a universal guarantee, just this
// measurement's documented cutoff.
export const MIN_LETTERS = 20;
export const MARGIN_THRESHOLD = 0.15;

/** Below the reliable-detection gate above but with enough letters to at least know the message
 * isn't code/formula/near-empty. */
export const MIN_LETTERS_GENERIC = 8;

/** Once the language universe is restricted to just a handful of real candidates, a much smaller
 * top1/top2 margin is enough to trust the result — there's far less room for an unrelated
 * language to sneak in when franc-min is only allowed to choose among 2-4 languages instead of
 * all ~82 it knows. */
export const NARROW_MARGIN_THRESHOLD = 0.05;

const enDisplayNames = new Intl.DisplayNames(['en'], { type: 'language' });

/** Strips code fences, inline code, $…$ / $$…$$ math and URLs — the parts of a message that
 * carry no language signal and would otherwise dilute franc-min's trigram sample. */
export function stripForDetection(text: string): string {
	return text
		.replace(/```[\s\S]*?```/g, ' ')
		.replace(/`[^`]*`/g, ' ')
		.replace(/\$\$[\s\S]*?\$\$/g, ' ')
		.replace(/\$[^$\n]*\$/g, ' ')
		.replace(/https?:\/\/\S+/g, ' ');
}

export function countLetters(text: string): number {
	return (text.match(/\p{L}/gu) ?? []).length;
}

export interface Detection {
	reliable: boolean;
	iso3?: string;
	margin?: number;
	letters: number;
}

/** franc-min based detection with the length + margin gate described above. */
export function detectReliable(rawText: string): Detection {
	const stripped = stripForDetection(rawText);
	const letters = countLetters(stripped);
	if (letters < MIN_LETTERS) return { reliable: false, letters };
	const all = francAll(stripped);
	if (all.length < 2 || all[0][0] === 'und') return { reliable: false, letters };
	const margin = all[0][1] - all[1][1];
	return { reliable: margin >= MARGIN_THRESHOLD, iso3: all[0][0], margin, letters };
}

/** Generic ISO 639-3 -> English language name via Intl.DisplayNames — no per-language table.
 * Returns undefined when the runtime doesn't recognize the code or echoes it back unchanged
 * (treated the same as "not reliable enough to name"). */
export function iso3ToEnglishName(iso3: string): string | undefined {
	try {
		const name = enDisplayNames.of(iso3);
		if (!name || name.toLowerCase() === iso3.toLowerCase()) return undefined;
		return name;
	} catch {
		return undefined;
	}
}

/** Folds case and diacritics so "İngilizce", "ingilizce" and "INGILIZCE" (or "Türkçe"/"turkce")
 * compare equal. Dotless ı is folded to i for the same reason. */
function normalizeLanguageName(s: string): string {
	return s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/ı/g, 'i').trim();
}

let nameIndex: Map<string, string> | null = null;

/** Every language franc-min can return, named in English, in Turkish and in the language
 * itself — all from Intl.DisplayNames, no hand-written table. Built once, lazily. */
function languageNameIndex(): Map<string, string> {
	if (nameIndex) return nameIndex;
	const codes = new Set<string>(Object.keys(expressions));
	for (const byScript of Object.values(francData)) for (const code of Object.keys(byScript)) codes.add(code);
	const index = new Map<string, string>();
	const add = (name: string | undefined, iso3: string) => {
		if (!name || name.toLowerCase() === iso3) return;
		const key = normalizeLanguageName(name);
		if (!index.has(key)) index.set(key, iso3);
	};
	const trDisplayNames = new Intl.DisplayNames(['tr'], { type: 'language' });
	for (const iso3 of codes) {
		try {
			add(enDisplayNames.of(iso3), iso3);
			add(trDisplayNames.of(iso3), iso3);
			add(new Intl.DisplayNames([iso3], { type: 'language' }).of(iso3), iso3);
		} catch {
			// a code this runtime's ICU has no locale data for — skip it
		}
	}
	nameIndex = index;
	return index;
}

/** The ISO 639-3 code for a language name as a user types it in LibrarySettings.allowedLanguages
 * ("Türkçe", "English", "İngilizce", "Deutsch", "한국어"), or undefined when it isn't one franc-min
 * can detect. Not franc(name): a single word is far too short for trigram detection ("English"
 * came back as Uzbek, "İngilizce" as Swahili). */
export function resolveLanguageName(name: string): string | undefined {
	return languageNameIndex().get(normalizeLanguageName(name));
}

export interface LanguageDecision {
	iso3: string;
	englishName: string;
	tier: 'reliable' | 'narrowed' | 'fallback';
	/** Top1/top2 margin at whichever tier actually decided — full-language-set margin for
	 * 'reliable', narrowed-candidate-set margin for 'narrowed', absent for 'fallback'. */
	margin?: number;
}

/**
 * Decides what language to name in a single directive line appended to the LAST user message
 * only; never tags historical turns.
 *
 * `priorUserMessages` should be this conversation's earlier user turns in order (raw text, as
 * sent by the user). The narrowed candidate set is derived entirely from this live conversation
 * plus the vault's own primary language and English — never a hand-written word/language list.
 *
 * Tiers:
 *   - fallback: the last message is too short (<MIN_LETTERS_GENERIC letters after stripping
 *     code/formula/urls) to read a language off of at all -> primary language.
 *   - reliable: franc-min is confident on the full ~82-language set (MIN_LETTERS/MARGIN_THRESHOLD).
 *   - narrowed: not reliable on the full set, but re-running franc-min restricted to {primary,
 *     English} union whatever languages were reliably detected in earlier turns clears a smaller
 *     margin (NARROW_MARGIN_THRESHOLD); otherwise falls through to primary.
 */
export function decideResponseLanguage(
	lastMessage: string,
	priorUserMessages: string[],
	primaryName: string
): LanguageDecision {
	// A primary name we can't map (a typo, a language franc-min doesn't cover) still works as a
	// fallback: the directive names it verbatim and the model reads it; it just can't be a
	// narrowing candidate.
	const resolvedPrimary = resolveLanguageName(primaryName);
	const primaryIso3 = resolvedPrimary ?? 'und';
	const primaryEnglishName = (resolvedPrimary && iso3ToEnglishName(resolvedPrimary)) ?? primaryName;

	const stripped = stripForDetection(lastMessage);
	const letters = countLetters(stripped);

	if (letters < MIN_LETTERS_GENERIC) {
		return { iso3: primaryIso3, englishName: primaryEnglishName, tier: 'fallback' };
	}

	// Tier 1: reliable on the full ~82-language set.
	if (letters >= MIN_LETTERS) {
		const all = francAll(stripped, { minLength: 1 });
		if (all.length >= 2 && all[0][0] !== 'und') {
			const margin = all[0][1] - all[1][1];
			if (margin >= MARGIN_THRESHOLD) {
				const name = iso3ToEnglishName(all[0][0]);
				if (name) return { iso3: all[0][0], englishName: name, tier: 'reliable', margin };
			}
		}
	}

	// Tier 2: narrow the candidate set to {primary, English} union whatever languages were
	// reliably detected (same full-set gate) in this conversation's earlier user turns, then
	// re-run franc-min restricted to just those candidates via its `only` option.
	const candidates = new Set<string>(resolvedPrimary ? [resolvedPrimary, 'eng'] : ['eng']);
	for (const prior of priorUserMessages) {
		const priorStripped = stripForDetection(prior);
		if (countLetters(priorStripped) < MIN_LETTERS) continue;
		const priorAll = francAll(priorStripped, { minLength: 1 });
		if (priorAll.length < 2 || priorAll[0][0] === 'und') continue;
		if (priorAll[0][1] - priorAll[1][1] >= MARGIN_THRESHOLD) candidates.add(priorAll[0][0]);
	}

	const narrowed = francAll(stripped, { only: [...candidates], minLength: 1 });
	let chosenIso3 = primaryIso3;
	let narrowMargin: number | undefined;
	if (narrowed.length >= 2) {
		narrowMargin = narrowed[0][1] - narrowed[1][1];
		if (narrowMargin >= NARROW_MARGIN_THRESHOLD) chosenIso3 = narrowed[0][0];
	} else if (narrowed.length === 1 && candidates.size === 1) {
		// Only English was a candidate (unresolvable primary): franc-min scores the single
		// candidate unconditionally, so this says nothing — keep the primary fallback.
	} else if (narrowed.length === 1) {
		chosenIso3 = narrowed[0][0];
	}
	const chosenName = iso3ToEnglishName(chosenIso3) ?? (chosenIso3 === primaryIso3 ? primaryEnglishName : chosenIso3);
	return { iso3: chosenIso3, englishName: chosenName, tier: 'narrowed', margin: narrowMargin };
}

/** The single directive line appended to the end of the last user message in 'match' mode — see
 * prompt.ts's buildPromptMessages. No trailing/leading whitespace; the caller decides how to join
 * it onto the message (prompt.ts uses "\n\n" the same way V2/V3/V4 did in the eval script). */
export function responseLanguageDirective(decision: LanguageDecision): string {
	return `(Answer in ${decision.englishName}.)`;
}
