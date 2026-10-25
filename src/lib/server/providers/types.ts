export interface ToolCall {
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

/** JSON-Schema function-tool definition, same shape both Ollama-native and
 * OpenAI-compatible wire formats accept (as {type:'function', function:{...}}
 * — adapters do that wrapping themselves, callers just pass this). */
export interface ToolDefinition {
	name: string;
	description: string;
	parameters: object;
}

export interface ChatMessage {
	role: 'system' | 'user' | 'assistant' | 'tool';
	content: string;
	/** Set on an assistant message that requested one or more tool calls —
	 * the following messages in the array must be one 'tool' message per
	 * entry here, each carrying that call's tool_call_id. */
	tool_calls?: ToolCall[];
	/** Set on a 'tool' message — which call this is the result of. */
	tool_call_id?: string;
	/** Set on a 'tool' message — the tool's name, mirrored back per the
	 * OpenAI/Ollama tool-message convention. */
	name?: string;
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
	/** Function tools the model may call mid-turn (e.g. reading a skill's
	 * supporting file) — omitted entirely when empty/undefined so providers
	 * that never learned about tools see no behavior change. */
	tools?: ToolDefinition[];
	/** Extra stop strings (Ollama: options.stop). Used by the resume path to end
	 * the stream where qwen3 would otherwise restart the answer inside a fake
	 * `<think>` block — see resume-plan.ts. Omitted means the model's own stops. */
	stop?: string[];
	/** The last message is a PARTIAL assistant answer the model must continue,
	 * not a finished earlier turn. Only meaningful for the provider that
	 * produced that text: another provider would read it as history and answer
	 * from scratch, so chat-fallback.ts never hops to a second provider for
	 * such a request — the caller restarts instead. */
	continuation?: boolean;
}

export type Chunk =
	| { type: 'reasoning'; text: string }
	| { type: 'text'; text: string }
	| { type: 'tool_call'; id: string; name: string; arguments: Record<string, unknown> }
	| {
			type: 'usage';
			prompt: number;
			completion: number;
			/** Ollama-native only, milliseconds — see ollama-usage.ts. Optional
			 * because a provider that reports only token counts stays valid. */
			promptMs?: number;
			completionMs?: number;
			loadMs?: number;
			/** The context window the request was actually served with. */
			numCtx?: number;
	  }
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
	/** The OpenAI-compatible /models endpoint's standard `created` field (unix seconds), when the
	 * provider returns one. Used by model-filter.ts as an age fallback for a model id the model catalog
	 * doesn't know about — without it, a catalog-unmatched model has no age signal at all. */
	created?: number;
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
