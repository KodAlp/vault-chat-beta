/**
 * F8 — a character budget for the prior-turn conversation history sent to the model (prompt.ts), so a very long
 * chat cannot grow the prompt past Ollama's context window and get silently truncated from the FRONT — where the
 * system rules (CORE_INVARIANTS) live (see prompt.ts / env.ts's serveCtxOverride doc comments; the nearCtxLimit
 * app-log flag exists precisely to detect this).
 *
 * Picked, not measured: the real app-log.jsonl (22 llm_timing records at the time of writing) never once hit
 * nearCtxLimit — max prompt seen was 5211/8192 tokens — so this is defensive insurance against a failure mode
 * that hasn't actually happened yet in real usage, not a fix for a measured problem. Same honesty as the other
 * *-limits.ts budgets (memory/review/skill) that were picked rather than tuned against live data.
 *
 * At ~4 chars/token (the same rough estimate ThinkingPanel.svelte uses) and an 8192-token window, the full
 * prompt budget is roughly 32,000 characters; retrieval context alone (k=6 chunks, up to ~2000 chars each) can
 * already use up to ~12,000 of that, plus the system blocks (CORE_INVARIANTS + memory/skill/review blocks).
 * 12,000 characters for history leaves real margin rather than claiming the whole remainder.
 */
export const MAX_HISTORY_CHARS = 12000;

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
