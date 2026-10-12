/**
 * Shared between the server (smalltalk-store.ts refuses anything longer) and the chat UI
 * (Chat.svelte only offers "Kaynaklar alakasız" for a message this short) — kept in its own
 * dependency-free module, like skill-limits.ts, so the two can never drift apart.
 *
 * A phrase longer than this is a sentence with content, not small talk: learning it would
 * only teach the gate to swallow real questions.
 */
export const MAX_PHRASE_CHARS = 80;

/**
 * Sources whose best vector match is at or below this cosine distance are a confident hit
 * (select-chunks.ts keeps anything up to 0.6, so 0.5 leaves a wide "weak" band just under the
 * cutoff — that band is where a greeting the gate missed ends up). Chat.svelte hides the
 * "Kaynaklar alakasız" button for confident hits: offering it on correct, used sources read as
 * the app doubting its own answer (#35).
 */
export const CONFIDENT_DISTANCE = 0.5;

/** Whether to show the "Kaynaklar alakasız" (teach small talk) button for an answer. */
export function shouldOfferNotRelevant(
	sources: { distance: number; via?: 'keyword' }[] | undefined,
	questionLength: number
): boolean {
	if (!sources?.length || questionLength <= 0 || questionLength > MAX_PHRASE_CHARS) return false;
	// Keyword-fallback chunks carry a placeholder distance, so they never count as confident.
	const best = Math.min(...sources.map((s) => (s.via === 'keyword' ? Infinity : s.distance)));
	return !(best <= CONFIDENT_DISTANCE);
}
