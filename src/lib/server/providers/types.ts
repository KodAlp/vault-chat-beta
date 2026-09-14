export interface ChatMessage {
	role: 'system' | 'user' | 'assistant';
	content: string;
}

export interface ChatRequest {
	model: string;
	messages: ChatMessage[];
	/** Ask for reasoning output, if the model/provider supports it. */
	think?: boolean;
	/** JSON Schema for structured output — Ollama-native concept; other
	 * providers accept it best-effort or ignore it. */
	format?: object;
	temperature?: number;
	/**
	 * A ceiling on completion length (Ollama: num_predict, OpenAI-compatible:
	 * max_tokens) — nothing in this codebase set this before, on any
	 * provider. Without it, a grammar-constrained decode that cannot legally
	 * stop early (minItems === maxItems in cards-schema.ts/quiz-schema.ts)
	 * has no backstop against the model's own context window running out
	 * mid-item once the prompt + accumulated output crowd it — the mechanism
	 * behind generate-cards.ts/generate-quiz.ts's per-batch quality
	 * collapse. Meant as a generous runaway guard sized per request by the
	 * caller (see those files' *OutputBudget() helpers), not a tight
	 * per-item allowance. */
	maxOutputTokens?: number;
}

export type Chunk =
	| { type: 'reasoning'; text: string }
	| { type: 'text'; text: string }
	| { type: 'usage'; prompt: number; completion: number }
	| { type: 'done' };

export interface ModelInfo {
	id: string;
	ctx: number;
	caps: { tools: boolean; reasoning: boolean };
	/** True for embedding-only models (e.g. bge-m3, nomic-embed-text) — they
	 * have no chat template and Ollama's /api/chat fails/misbehaves against
	 * them, so pickers must filter these out rather than offer them as a
	 * chat/generation choice. Undefined/false means chat-capable. */
	embeddingOnly?: boolean;
}

export type ProviderHealth = 'ok' | 'unreachable' | 'auth_error';

/**
 * Best-effort snapshot of a cloud provider's own rate-limit headers, kept on
 * the adapter instance and updated on every chat() response that carries
 * them. Coverage is inherently uneven — Groq/Mistral send remaining/limit/
 * reset on every response, OpenRouter/Gemini only on a 429 — so any field
 * here may be absent even when the provider is otherwise fine. Never throw
 * or block on missing headers; this is a UI nicety, not a gate.
 */
export interface RateLimitSnapshot {
	remainingRequests?: number;
	limitRequests?: number;
	resetRequestsAt?: string;
	remainingTokens?: number;
	limitTokens?: number;
	resetTokensAt?: string;
	/** Set only when the most recent call actually returned 429. */
	retryAfterAt?: string;
	capturedAt: string;
}

export interface ProviderAdapter {
	id: string;
	chat(req: ChatRequest, signal: AbortSignal): AsyncIterable<Chunk>;
	listModels(): Promise<ModelInfo[]>;
	health(): Promise<ProviderHealth>;
	/** Optional — only OpenAI-compatible adapters capture rate-limit headers. */
	getRateLimitInfo?(): RateLimitSnapshot | null;
}

export type ProviderErrorKind =
	| 'network'
	| 'timeout_connect'
	| 'timeout_first_token'
	| 'timeout_idle'
	| 'http_429'
	| 'http_5xx'
	| 'auth'
	| 'bad_request'
	| 'context_length'
	| 'unknown';

const RETRYABLE_KINDS: ReadonlySet<ProviderErrorKind> = new Set([
	'network',
	'timeout_connect',
	'timeout_first_token',
	'timeout_idle',
	'http_429',
	'http_5xx'
]);

/**
 * Every provider failure gets classified into one of these before it
 * leaves providers/ — the fallback policy in registry.ts only ever looks
 * at `kind`/`retryable`, never re-parses a raw HTTP status or error
 * message. `retryable` is derived once here (skill's taxonomy), not left
 * for callers to re-decide differently each time.
 */
export class ProviderError extends Error {
	readonly kind: ProviderErrorKind;
	readonly providerId: string;
	readonly retryable: boolean;

	constructor(kind: ProviderErrorKind, providerId: string, message: string) {
		super(message);
		this.name = 'ProviderError';
		this.kind = kind;
		this.providerId = providerId;
		this.retryable = RETRYABLE_KINDS.has(kind);
	}
}
