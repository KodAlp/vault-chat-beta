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
