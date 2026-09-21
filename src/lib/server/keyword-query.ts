/**
 * Turns a user question into an FTS5 MATCH expression for the keyword fallback
 * (retrieve.ts). Pure and dependency-free so it runs under plain `tsx --test`.
 *
 * Two things matter here:
 *
 * 1. FTS5 has its own query syntax (AND/OR/NOT/NEAR, `*`, parentheses, column
 *    filters like `title:x`, quoted phrases). A question is untrusted text, so
 *    every term is reduced to letters/digits/underscore and then wrapped in
 *    double quotes: inside quotes FTS5 treats it as a literal phrase, so none of
 *    that syntax can be smuggled in.
 * 2. This is a FALLBACK, used when vector search found nothing usable. Stopwords
 *    (question words, articles) would match almost every chunk and bury the
 *    terms that carry the meaning, so they are dropped.
 *
 * Known limit, stated so it is not mistaken for a bug: the vaults are mostly
 * English while questions are often Turkish. A Turkish content word will not
 * match an English chunk; this helps where terms are shared (B-tree, TCP,
 * identifiers, numbers). Bridging languages would need an LLM call to rewrite
 * the query, which this deliberately does not do.
 */

export type FtsMode = 'and' | 'or';

/** More terms than this add noise, not recall, and make the AND form useless. */
export const MAX_FTS_TERMS = 12;
const MIN_TERM_LENGTH = 2;

/** Function words that carry no topic. Deliberately short: a term that is
 * missing here is merely a weaker match, a term wrongly listed here is lost. */
const STOPWORDS = new Set([
	// Turkish
	've', 'veya', 'ile', 'bir', 'bu', 'şu', 'o', 'için', 'nedir', 'nasıl', 'neden', 'ne', 'mi', 'mı', 'mu', 'mü',
	'de', 'da', 'ki', 'gibi', 'daha', 'çok', 'en', 'olan', 'olarak', 'hangi', 'kim', 'nerede', 'kısa', 'kısaca',
	'cevapla', 'açıkla', 'anlat', 'hakkında', 'arasındaki', 'göre', 'kadar', 'sonra', 'önce',
	// English
	'the', 'a', 'an', 'of', 'and', 'or', 'to', 'in', 'on', 'for', 'is', 'are', 'was', 'were', 'be', 'what', 'how',
	'why', 'does', 'do', 'with', 'by', 'as', 'at', 'from', 'that', 'this', 'it', 'explain', 'describe', 'about'
]);

/** Distinct content terms of a question, lowercased, stopwords and one-letter
 * fragments removed. Splits on anything that is not a letter, digit or
 * underscore (so `B-tree` yields `tree`, and `heading_path` stays whole). */
export function extractTerms(query: string): string[] {
	const seen = new Set<string>();
	const terms: string[] = [];
	for (const raw of query.normalize('NFC').split(/[^\p{L}\p{N}_]+/u)) {
		const term = raw.toLowerCase();
		if (term.length < MIN_TERM_LENGTH || STOPWORDS.has(term) || seen.has(term)) continue;
		seen.add(term);
		terms.push(term);
	}
	// Longer terms are usually rarer, hence more selective; keep the best few.
	if (terms.length > MAX_FTS_TERMS) {
		return [...terms].sort((a, b) => b.length - a.length).slice(0, MAX_FTS_TERMS);
	}
	return terms;
}

/** FTS5 MATCH expression, or null when the question has no usable term.
 * 'and' requires every term (precise), 'or' any of them (recall). */
export function buildFtsQuery(query: string, mode: FtsMode = 'or'): string | null {
	const terms = extractTerms(query);
	if (terms.length === 0) return null;
	// Terms are letters/digits/underscore only, so a double quote cannot occur;
	// doubling it anyway is FTS5's own escape and keeps this safe if that changes.
	return terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(mode === 'and' ? ' AND ' : ' OR ');
}

/** A message needs at least this many distinct content terms before the keyword
 * fallback may run. */
export const MIN_FALLBACK_TERMS = 2;

/**
 * The FTS5 expression the keyword FALLBACK is allowed to run, or null when the
 * message does not earn a keyword search at all.
 *
 * Why a gate and not a longer stopword list: the fallback runs exactly when the
 * vector search found nothing, and that is what a greeting, slang or small talk
 * looks like in ANY language ("merhaba", "sup dawg", "napıyon lan"). Such words
 * turn up by accident in a technical corpus (a code sample, an example
 * sentence), and a keyword hit skips the distance threshold, so the chat showed
 * an unrelated note as its source and the model wove it into the answer. A word
 * list cannot cover every language and slang.
 *
 * The rule is language-independent instead: one stray word is not evidence, but
 * two or more distinct terms appearing together in one chunk is. So it is AND
 * only (an OR pass matched 12 of 24 multilingual greeting/slang messages against
 * the real index, AND with two or more terms matched 0) and it needs
 * MIN_FALLBACK_TERMS terms. The cost is stated, not hidden: a Turkish question
 * over an English vault rarely has two terms that co-occur (3 of 232 real
 * multi-term messages did), so in practice the fallback now rescues precise
 * multi-term matches such as "FreeRTOS task scheduling" and stays out of the way
 * of chit-chat.
 */
export function buildFallbackQuery(query: string): string | null {
	if (extractTerms(query).length < MIN_FALLBACK_TERMS) return null;
	return buildFtsQuery(query, 'and');
}
