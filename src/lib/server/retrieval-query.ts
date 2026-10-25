import type { ChatMessage } from '#lib/types.js';

/**
 * How many trailing user turns feed the embedding query. Not one, because
 * retrieval used to embed `lastUser.content` verbatim: in the real transcript
 * that broke this feature, "Selam bana türev anlat" was still generating when
 * two more messages arrived before any reply — "eeee cevap nerde amk", then
 * "oe bi cevap verecen ananı" — so the query that actually ran was that last,
 * topic-free interjection, and the search returned van Emde Boas trees, Big-O
 * and Svelte. That was three user turns in a row with zero replies between
 * them, so a window of 2 (the interjection plus its immediate predecessor,
 * itself also topic-free) would still have missed the actual subject one
 * turn further back — reproduced as a failing test before this was raised to
 * 3. The same flaw makes any ordinary follow-up ("daha basit anlat", "neden?")
 * retrieve against a sentence that names no topic at all.
 *
 * Bounded rather than unbounded: the point is to carry the *current* subject
 * across a short burst of follow-ups, not to accumulate a chat's whole
 * history into one vector, which would blur the query once the conversation
 * moves on to a different subject.
 */
const QUERY_TURNS = 3;

/** Total budget for the assembled query. bge-m3 truncates at 8192 tokens, so
 * this is about keeping the newest turn dominant, not about model limits. */
const MAX_QUERY_CHARS = 300;

/**
 * The text actually embedded for retrieval, assembled from the tail of the
 * conversation rather than the last message alone.
 *
 * The last user message is always included in full and placed last; earlier
 * turns are prepended only while they fit the budget, so a long final question
 * simply behaves as it did before.
 */
export function buildRetrievalQuery(messages: ChatMessage[]): string {
	const userTurns = messages.filter((m) => m.role === 'user').map((m) => m.content.trim()).filter(Boolean);
	if (userTurns.length === 0) return '';

	const last = userTurns[userTurns.length - 1];
	const parts = [last];
	let budget = MAX_QUERY_CHARS - last.length;

	for (let i = userTurns.length - 2; i >= 0 && parts.length < QUERY_TURNS; i--) {
		const candidate = userTurns[i];
		// Skip a turn the user simply repeated — it adds no new signal and
		// would evict the one genuinely earlier turn we have room for.
		if (candidate === last) continue;
		if (candidate.length > budget) continue;
		parts.unshift(candidate);
		budget -= candidate.length + 1;
	}

	return parts.join('\n');
}
