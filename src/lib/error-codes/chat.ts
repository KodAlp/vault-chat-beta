// Phase 2 owner: the chat route (/api/chat, Chat.svelte, Message.svelte).
//
// CHAT_FALLBACK_* / CHAT_NO_CHAIN / CHAT_CONTINUATION_UNAVAILABLE /
// CHAT_NO_MODEL_RESOLVED come from chat-fallback.ts's provider-chain walk —
// that module is also imported by the five generators (quiz/cards/report/
// mindmap/slides), so these codes are technically cross-cutting, but they
// live here since chat is the only caller that renders them inline as a
// stream notice today (see chat-fallback.ts's doc comment on why its own
// exported function signatures had to stay stable).
export const CHAT_CODES = [
	'CHAT_INVALID_BODY',
	'CHAT_LAST_MESSAGE_NOT_USER',
	'CHAT_EMPTY_ANSWER_RETRY',
	'CHAT_CORRUPTION_RETRY',
	'CHAT_CORRUPTION_RESUME',
	'CHAT_CORRUPTION_GAVE_UP',
	'CHAT_NO_ANSWER',
	'CHAT_SAVE_FAILED',
	'OLLAMA_UNREACHABLE',
	'CHAT_FALLBACK_PINNED_UNAVAILABLE',
	'CHAT_FALLBACK_NO_DEFAULT_MODEL',
	'CHAT_FALLBACK_RATE_LIMITED',
	'CHAT_FALLBACK_UNAVAILABLE',
	'CHAT_NO_CHAIN',
	'CHAT_CONTINUATION_UNAVAILABLE',
	'CHAT_NO_MODEL_RESOLVED',
	'CHAT_DELETE_FAILED',
	'CHAT_PATCH_NO_FIELDS'
] as const;
