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
}

export type ProviderHealth = 'ok' | 'unreachable' | 'auth_error';

export interface ProviderAdapter {
	id: string;
	chat(req: ChatRequest, signal: AbortSignal): AsyncIterable<Chunk>;
	listModels(): Promise<ModelInfo[]>;
	health(): Promise<ProviderHealth>;
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
