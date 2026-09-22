/**
 * Cheap hallucination-risk signal: scans model-generated text for hedge/
 * uncertainty phrases instead of a second LLM call. Single-purpose word-list
 * matching, not a scored/weighted classifier — the UI shows the exact
 * matched phrases so a false positive is self-evident to the reader rather
 * than hidden behind an opaque score. See api/chat/+server.ts's
 * computeHedges() for where this is invoked — both the think-mode reasoning
 * trace (when there is one) and the final answer text (always), merged via
 * mergeHedgeMatches below. detectHallucinationHedges() itself is text-source
 * agnostic despite the `thinking`-flavored parameter name below.
 *
 * Bare high-frequency words like "olabilir" ("could be") or "maybe" are
 * deliberately excluded — they're too common in confident Turkish/English
 * to carry signal on their own; only more specific compound hedges are
 * listed.
 */
const HEDGE_PHRASES: string[] = [
	// Turkish
	'emin değilim',
	'emin olamıyorum',
	'tam emin değilim',
	'çok emin değilim',
	'sanırım',
	'galiba',
	'tahminimce',
	'tahmin ediyorum',
	'kesin değilim',
	'kesin bilgim yok',
	'bilmiyorum',
	'hatırlamıyorum',
	'kaynaklarda bulamadım',
	'kaynakta bulamadım',
	'kaynaklarda yok',
	'bahsetmiyor',
	'değinmiyor',
	'belirtmiyor',
	'yanılıyor olabilirim',
	'uydurmuş olabilirim',
	'uydurmayayım',
	// English
	"i'm not sure",
	'i am not sure',
	"i'm uncertain",
	'i am uncertain',
	'not certain',
	'unverified',
	'i cannot find',
	"can't find",
	"doesn't mention",
	'does not mention',
	'not specified',
	'as far as i know',
	'to my knowledge',
	"i don't have information",
	'no information about',
	'i might be wrong',
	'i could be wrong',
	"i'm guessing",
	'i am guessing',
	'let me guess'
];

const HEDGE_PATTERNS: { phrase: string; regex: RegExp }[] = HEDGE_PHRASES.map((phrase) => ({
	phrase,
	regex: new RegExp(`\\b${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')
}));

export const MAX_HEDGE_MATCHES = 6;

/** Returns the distinct matched hedge phrases (original casing from the
 * list, not the source text) found in `thinking`, capped at MAX_HEDGE_MATCHES.
 * Empty array means no detected risk. */
export function detectHallucinationHedges(thinking: string): string[] {
	if (!thinking) return [];
	const matches: string[] = [];
	for (const { phrase, regex } of HEDGE_PATTERNS) {
		if (matches.length >= MAX_HEDGE_MATCHES) break;
		if (regex.test(thinking)) matches.push(phrase);
	}
	return matches;
}

/** Merges hedge matches found in two texts (the reasoning trace and the final answer) — each
 * detectHallucinationHedges() call already caps at MAX_HEDGE_MATCHES on its own, so combining two
 * full lists needs deduping and re-capping, not a plain concat. */
export function mergeHedgeMatches(a: readonly string[], b: readonly string[]): string[] {
	return [...new Set([...a, ...b])].slice(0, MAX_HEDGE_MATCHES);
}
