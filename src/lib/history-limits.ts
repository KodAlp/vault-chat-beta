/**
 * F8 — a character budget for the prior-turn conversation history sent to the model (prompt.ts), so a very long
 * chat cannot grow the prompt past Ollama's context window and get silently truncated from the FRONT — where the
 * system rules (CORE_INVARIANTS) live (see prompt.ts / env.ts's serveCtxOverride doc comments; the nearCtxLimit
 * app-log flag exists precisely to detect this).
 *
 * Measured (app-log.jsonl, 60 llm_timing records, 2026-09-20..2026-10-18): nearCtxLimit fired twice, both on
 * 2026-10-05 in one chat whose history was 12.5K and 16.2K chars (trimmed to ~12K): prompt 6183 / 6069 tokens +
 * completion 1321 / 1546 = 91-93% of 8192. System + retrieval context alone is already ~4-5K tokens (a prompt with
 * 455 chars of history was 5211 tokens), and the largest completion seen was ~2.6K tokens (thinking on). So a fixed
 * 12K-char history can push the prompt to ~6.2K tokens and leave < 2K for the answer; a longer answer would overflow
 * the window and Ollama would shift context, dropping the FRONT (the system rules).
 *
 * Rule: MAX_HISTORY_CHARS is only the ceiling. The real budget is what is left in the window, see
 * historyBudgetChars: numCtx - (everything else in the prompt) - a reserved output allowance, converted to chars.
 * Unknown window (cloud providers etc.): the ceiling alone applies.
 */
export const MAX_HISTORY_CHARS = 12000;

/** Conservative: Turkish / multilingual text tokenizes denser than English's ~4 chars/token. */
export const HISTORY_CHARS_PER_TOKEN = 3;

/**
 * Output tokens kept free in the window. The largest completion observed was ~2.6K tokens incl. thinking; the
 * 4096 CHAT_MAX_OUTPUT_TOKENS cap would leave no room for history at all in an 8192 window, so 2048 is the
 * compromise: nearCtxLimit (0.9) still flags the rare answer that runs past it.
 */
export const HISTORY_RESERVE_OUTPUT_TOKENS = 2048;

/**
 * History character budget from what is actually left in the context window:
 * (numCtx - estimated tokens of the rest of the prompt - reserved output tokens) * charsPerToken,
 * clamped to [0, MAX_HISTORY_CHARS]. A budget of 0 is fine: trimConversationHistory always keeps the latest turn.
 */
export function historyBudgetChars(opts: {
	numCtx: number;
	otherPromptChars: number;
	reserveOutputTokens?: number;
	charsPerToken?: number;
}): number {
	const cpt = opts.charsPerToken ?? HISTORY_CHARS_PER_TOKEN;
	const reserve = opts.reserveOutputTokens ?? HISTORY_RESERVE_OUTPUT_TOKENS;
	const availableTokens = opts.numCtx - Math.ceil(opts.otherPromptChars / cpt) - reserve;
	return Math.max(0, Math.min(MAX_HISTORY_CHARS, Math.floor(availableTokens * cpt)));
}

/**
 * Keeps as many of the most recent turns as fit within `maxChars`, dropping the oldest ones first — the
 * translation of the spec's "low-value historical context compacted first" for a plain chat (there is no
 * "active plan"/"user constraints" concept here to rank above it, just recency). The single most recent turn is
 * always kept even if it alone exceeds the budget, so this never returns an empty array from a non-empty input.
 */
export function trimConversationHistory<T extends { content: string }>(
	turns: readonly T[],
	maxChars: number = MAX_HISTORY_CHARS
): T[] {
	const kept: T[] = [];
	let budget = maxChars;
	for (let i = turns.length - 1; i >= 0; i--) {
		const len = turns[i].content.length;
		if (kept.length > 0 && len > budget) break;
		kept.unshift(turns[i]);
		budget -= len;
	}
	return kept;
}
