/**
 * Shared between the server (smalltalk-store.ts refuses anything longer) and the chat UI
 * (Chat.svelte only offers "Kaynaklar alakasız" for a message this short) — kept in its own
 * dependency-free module, like skill-limits.ts, so the two can never drift apart.
 *
 * A phrase longer than this is a sentence with content, not small talk: learning it would
 * only teach the gate to swallow real questions.
 */
export const MAX_PHRASE_CHARS = 80;
