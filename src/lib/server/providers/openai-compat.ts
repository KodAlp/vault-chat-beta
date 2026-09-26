import { ProviderError, type ProviderErrorKind } from './types';
import type {
	ProviderAdapter,
	ChatRequest,
	ChatMessage,
	Chunk,
	ModelInfo,
	ProviderHealth,
	RateLimitSnapshot,
	ToolDefinition
} from './types';
import { createThinkTagNormalizer, reasoningContentChunk, textChunk } from './normalize';
import { logAppEvent } from '../app-log';

/**
 * Standard OpenAI wire format — used by every cloud provider plus Ollama's
 * own /v1 surface. Assistant tool_calls carry an `id` and JSON-*stringified*
 * arguments (unlike our internal ChatMessage, which keeps arguments as a
 * parsed object); tool-result messages match back via `tool_call_id`, not
 * Ollama-native's `tool_name` (see ollama.ts's toOllamaWireMessages for that
 * dialect). This is the one place that downgrades our internal shape to
 * what an OpenAI-compatible endpoint actually understands.
 */
function toOpenAIWireMessages(messages: ChatMessage[]): unknown[] {
	return messages.map((m) => {
		if (m.role === 'assistant' && m.tool_calls?.length) {
			return {
				role: 'assistant',
				content: m.content,
				tool_calls: m.tool_calls.map((tc) => ({
					id: tc.id,
					type: 'function',
					function: { name: tc.name, arguments: JSON.stringify(tc.arguments) }
				}))
			};
		}
		if (m.role === 'tool') {
			return { role: 'tool', tool_call_id: m.tool_call_id, content: m.content };
		}
		return { role: m.role, content: m.content };
	});
}

function toOpenAIWireTools(tools: ToolDefinition[]): unknown[] {
	return tools.map((t) => ({
		type: 'function',
		function: { name: t.name, description: t.description, parameters: t.parameters }
	}));
}

export interface Timeouts {
	connectMs: number;
	firstTokenMs: number;
	idleMs: number;
}

export interface OpenAICompatConfig {
	id: string;
	baseUrl: string;
	apiKey?: string | null;
	reasoningDialect: 'think-tags' | 'reasoning_content' | 'none';
	timeouts: Timeouts;
}

export function classifyHttpStatus(status: number, bodyText: string): ProviderErrorKind {
	if (status === 401 || status === 403) return 'auth';
	if (status === 429) return 'http_429';
	if (status >= 500) return 'http_5xx';
	if (status === 400) {
		return /context.?length|too many tokens|maximum context/i.test(bodyText)
			? 'context_length'
			: 'bad_request';
	}
	return 'unknown';
}

/**
 * Parses either a plain seconds count ("30") or a Go/OpenAI-style duration
 * string ("2m59.56s", "1h2m3s", "500ms") into total seconds. Unit-tagged
 * loop (not an anchored slot regex) so "ms" is never swallowed by a greedy
 * "m" match, and units may appear in any subset/order. Returns null when
 * nothing recognizable is found.
 */
function parseDurationSeconds(value: string): number | null {
	const trimmed = value.trim();
	if (/^\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
	const unitSeconds: Record<string, number> = { ms: 0.001, h: 3600, m: 60, s: 1 };
	const re = /(\d+(?:\.\d+)?)(ms|h|m|s)/g;
	let total = 0;
	let matched = false;
	let m: RegExpExecArray | null;
	while ((m = re.exec(trimmed))) {
		matched = true;
		total += Number(m[1]) * unitSeconds[m[2]];
	}
	return matched ? total : null;
}

/** Duration string, or an HTTP-date (retry-after's other legal form per RFC 9110) → absolute ISO instant. */
function resolveFutureInstant(value: string): string | null {
	const seconds = parseDurationSeconds(value);
	if (seconds !== null) return new Date(Date.now() + seconds * 1000).toISOString();
	const asDate = new Date(value);
	return Number.isNaN(asDate.getTime()) ? null : asDate.toISOString();
}

/**
 * Node's fetch collapses every transport failure into the message "fetch
 * failed"; the part that actually says what happened
 * (SELF_SIGNED_CERT_IN_CHAIN, ECONNRESET, ENOTFOUND, ECONNREFUSED) sits on
 * `err.cause`, occasionally one level deeper still. That detail used to be
 * dropped, which made a real TLS-interception failure in the field
 * indistinguishable from "the internet is down" — diagnosing one needed a
 * separate Node probe, which a user cannot write. Flattened into the message
 * so app-log.jsonl alone is enough.
 */
export function describeNetworkError(err: unknown): string {
	const base = err instanceof Error ? err.message : String(err);
	let cause: unknown = err instanceof Error ? err.cause : undefined;
	for (let depth = 0; depth < 2 && cause; depth++) {
		const detail = (cause as { code?: string }).code ?? (cause instanceof Error ? cause.message : undefined);
		if (detail && detail !== base) return `${base} (${detail})`;
		cause = cause instanceof Error ? cause.cause : undefined;
	}
	return base;
}

/**
 * Generic adapter for any OpenAI-compatible /chat/completions endpoint —
 * covers every cloud provider plus Ollama (via its own /v1 surface, see
 * providers/ollama.ts). One implementation, one set of timeout/error/
 * reasoning-normalization semantics, per the skill's "one interface,
 * provider adapters underneath" rule.
 */
export class OpenAICompatAdapter implements ProviderAdapter {
	readonly id: string;
	protected config: OpenAICompatConfig;
	/** Rate-limit headers seen on the last response that carried any —
	 * see RateLimitSnapshot's doc comment for why coverage is uneven
	 * across providers. */
	private rateLimitSnapshot: RateLimitSnapshot | null = null;

	constructor(config: OpenAICompatConfig) {
		this.id = config.id;
		this.config = config;
	}

	/** Merges any rate-limit headers present on `res` into the snapshot;
	 * fields the response doesn't carry keep their last known value. Only
	 * creates a snapshot at all once at least one such header has actually
	 * been seen — a provider that never sends them (Gemini/OpenRouter on a
	 * successful response) stays null rather than looking "live" with a
	 * fresh timestamp and no data. */
	private captureRateLimitHeaders(res: Response): void {
		const h = res.headers;
		const remainingRequests = h.get('x-ratelimit-remaining-requests');
		const limitRequests = h.get('x-ratelimit-limit-requests');
		const resetRequests = h.get('x-ratelimit-reset-requests');
		const remainingTokens = h.get('x-ratelimit-remaining-tokens');
		const limitTokens = h.get('x-ratelimit-limit-tokens');
		const resetTokens = h.get('x-ratelimit-reset-tokens');
		const retryAfter = h.get('retry-after');

		const hasAnyData =
			remainingRequests !== null ||
			limitRequests !== null ||
			resetRequests !== null ||
			remainingTokens !== null ||
			limitTokens !== null ||
			resetTokens !== null ||
			retryAfter !== null;
		if (!hasAnyData) return;

		const snapshot: RateLimitSnapshot = { ...(this.rateLimitSnapshot ?? {}), capturedAt: new Date().toISOString() };
		if (remainingRequests !== null) snapshot.remainingRequests = Number(remainingRequests);
		if (limitRequests !== null) snapshot.limitRequests = Number(limitRequests);
		if (resetRequests !== null) {
			const at = resolveFutureInstant(resetRequests);
			if (at) snapshot.resetRequestsAt = at;
		}
		if (remainingTokens !== null) snapshot.remainingTokens = Number(remainingTokens);
		if (limitTokens !== null) snapshot.limitTokens = Number(limitTokens);
		if (resetTokens !== null) {
			const at = resolveFutureInstant(resetTokens);
			if (at) snapshot.resetTokensAt = at;
		}
		if (retryAfter !== null) {
			const at = resolveFutureInstant(retryAfter);
			if (at) snapshot.retryAfterAt = at;
		}
		this.rateLimitSnapshot = snapshot;
	}

	getRateLimitInfo(): RateLimitSnapshot | null {
		return this.rateLimitSnapshot;
	}

	protected chatUrl(): string {
		return `${this.config.baseUrl}/chat/completions`;
	}

	protected headers(): Record<string, string> {
		const h: Record<string, string> = { 'content-type': 'application/json' };
		if (this.config.apiKey) h.authorization = `Bearer ${this.config.apiKey}`;
		return h;
	}

	/** Hook for provider-specific extra body fields (e.g. Ollama's
	 * non-standard `think` flag) — overridable without duplicating the
	 * whole request/stream/timeout/error-handling machinery in chat(). */
	protected extraBody(_req: ChatRequest): Record<string, unknown> {
		return {};
	}

	/**
	 * Three independent timeout counters (skill's explicit "never one flat
	 * timeout" rule) all funnel into a single internal AbortController that
	 * also observes the caller's external signal — fetch only takes one
	 * signal, so this is where the two get merged. `getTimeoutKind()` lets
	 * the caller distinguish "we timed out" from "the caller aborted us"
	 * from "genuine network failure" after the fact.
	 */
	/** Protected, not private: providers/ollama.ts reuses this for its
	 * native-endpoint chat() override, which needs the identical
	 * connect/first-token/idle timeout semantics without duplicating
	 * them — the /v1 surface silently ignores num_ctx (empirically
	 * confirmed against a real running instance: options.num_ctx on
	 * /v1/chat/completions never changes what ollama ps reports), so
	 * that override talks to /api/chat directly instead of super.chat(). */
	protected makeAbortBridge(externalSignal: AbortSignal) {
		const controller = new AbortController();
		let timeoutKind: ProviderErrorKind | null = null;
		let timer: ReturnType<typeof setTimeout> | undefined;

		const onExternalAbort = () => controller.abort();
		if (externalSignal.aborted) controller.abort();
		else externalSignal.addEventListener('abort', onExternalAbort);

		function armTimer(ms: number, kind: ProviderErrorKind) {
			if (timer) clearTimeout(timer);
			timer = setTimeout(() => {
				timeoutKind = kind;
				controller.abort();
			}, ms);
		}
		function clearTimer() {
			if (timer) clearTimeout(timer);
			timer = undefined;
		}
		function dispose() {
			clearTimer();
			externalSignal.removeEventListener('abort', onExternalAbort);
		}

		return { signal: controller.signal, armTimer, clearTimer, dispose, getTimeoutKind: () => timeoutKind };
	}

	/**
	 * `message` is now just the external detail, with no `${id}: ...` prefix
	 * or Turkish wording of its own — app-error.ts's toCodedError already
	 * maps a ProviderError to `PROVIDER_<KIND>` with `{provider: this.id,
	 * detail: message}`, and ServerErrors.PROVIDER_<KIND> supplies the
	 * localized sentence around it (see server-error.ts/error-format.ts).
	 * `message` staying human-readable-but-uncoded is still correct here:
	 * it is a raw external detail (a timeout kind, a network cause, an HTTP
	 * body), never a sentence shown on its own.
	 */
	protected toProviderError(err: unknown, externalSignal: AbortSignal, timeoutKind: ProviderErrorKind | null): unknown {
		// A genuine caller-initiated abort (stop button, inflight supersede) is
		// not a provider failure — rethrow it as-is so callers keep treating
		// AbortError as "cancelled", exactly like today's ollama.ts does.
		if (externalSignal.aborted && !timeoutKind) return err;
		if (timeoutKind) {
			return new ProviderError(timeoutKind, this.id, timeoutKind);
		}
		return new ProviderError('network', this.id, describeNetworkError(err));
	}

	async *chat(req: ChatRequest, signal: AbortSignal): AsyncGenerator<Chunk> {
		const { connectMs, firstTokenMs, idleMs } = this.config.timeouts;
		const bridge = this.makeAbortBridge(signal);
		bridge.armTimer(connectMs, 'timeout_connect');

		let res: Response;
		try {
			res = await fetch(this.chatUrl(), {
				method: 'POST',
				headers: this.headers(),
				body: JSON.stringify({
					model: req.model,
					messages: toOpenAIWireMessages(req.messages),
					stream: true,
					...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
					...(req.maxOutputTokens !== undefined ? { max_tokens: req.maxOutputTokens } : {}),
					...(req.tools?.length ? { tools: toOpenAIWireTools(req.tools) } : {}),
					// Standard OpenAI structured-output shape — confirmed against a
					// real running Ollama instance that its /v1 surface honors THIS
					// nested {type, json_schema:{name, schema}} form correctly, but
					// silently ignores a raw schema passed directly (the model just
					// free-formed a markdown-fenced answer instead of constrained
					// JSON). Do not "simplify" this back to a flat schema.
					...(req.format
						? { response_format: { type: 'json_schema', json_schema: { name: 'response', schema: req.format } } }
						: {}),
					...this.extraBody(req)
				}),
				signal: bridge.signal
			});
		} catch (err) {
			const providerErr = this.toProviderError(err, signal, bridge.getTimeoutKind());
			bridge.dispose();
			throw providerErr;
		}
		bridge.clearTimer();
		this.captureRateLimitHeaders(res);

		if (!res.ok || !res.body) {
			const bodyText = await res.text().catch(() => '');
			bridge.dispose();
			throw new ProviderError(
				classifyHttpStatus(res.status, bodyText),
				this.id,
				`HTTP ${res.status} — ${bodyText.slice(0, 300)}`
			);
		}

		bridge.armTimer(firstTokenMs, 'timeout_first_token');

		const reader = res.body.getReader();
		const decoder = new TextDecoder();
		let buffer = '';
		const thinkNormalizer =
			this.config.reasoningDialect === 'think-tags' ? createThinkTagNormalizer() : null;
		// OpenAI streams tool calls incrementally: only `index` is guaranteed on
		// every fragment, `id`/`function.name` typically arrive once on the
		// first fragment for that index, and `function.arguments` accumulates
		// as JSON-string fragments across many chunks — nothing is a complete
		// tool_call until the stream itself ends (unlike Ollama, which sends
		// the whole array in one line; see ollama.ts's parser for that path).
		const toolCallAcc = new Map<number, { id?: string; name?: string; argsText: string }>();

		try {
			while (true) {
				let readResult: ReadableStreamReadResult<Uint8Array>;
				try {
					readResult = await reader.read();
				} catch (err) {
					throw this.toProviderError(err, signal, bridge.getTimeoutKind());
				}
				if (readResult.done) break;

				bridge.armTimer(idleMs, 'timeout_idle');
				buffer += decoder.decode(readResult.value, { stream: true });
				const lines = buffer.split('\n');
				buffer = lines.pop() ?? '';

				for (const line of lines) {
					const trimmed = line.trim();
					if (!trimmed.startsWith('data:')) continue;
					const payload = trimmed.slice(5).trim();
					if (payload === '[DONE]') continue;

					let json: {
						choices?: [
							{
								delta?: {
									content?: string;
									reasoning_content?: string;
									reasoning?: string;
									tool_calls?: {
										index: number;
										id?: string;
										function?: { name?: string; arguments?: string };
									}[];
								};
							}
						];
					};
					try {
						json = JSON.parse(payload);
					} catch {
						continue; // a stray non-JSON keep-alive line — ignore, not fatal
					}
					const delta = json.choices?.[0]?.delta;
					if (!delta) continue;

					// Structured-reasoning-field dialect: different servers use different
					// field names for the same concept (DeepSeek: reasoning_content;
					// this Ollama build: reasoning, empirically confirmed against a real
					// running instance — no inline <think> tags appear on its /v1 surface
					// at all despite the field being commonly assumed). Accept either.
					const reasoningField = delta.reasoning_content ?? delta.reasoning;
					if (this.config.reasoningDialect === 'reasoning_content' && reasoningField) {
						yield reasoningContentChunk(reasoningField);
					}
					if (delta.content) {
						if (thinkNormalizer) {
							for (const chunk of thinkNormalizer.feed(delta.content)) yield chunk;
						} else {
							yield textChunk(delta.content);
						}
					}
					if (delta.tool_calls) {
						for (const tc of delta.tool_calls) {
							const entry = toolCallAcc.get(tc.index) ?? { argsText: '' };
							if (tc.id) entry.id = tc.id;
							if (tc.function?.name) entry.name = tc.function.name;
							if (tc.function?.arguments) entry.argsText += tc.function.arguments;
							toolCallAcc.set(tc.index, entry);
						}
					}
				}
			}
			if (thinkNormalizer) {
				for (const chunk of thinkNormalizer.flush()) yield chunk;
			}
			for (const [index, entry] of [...toolCallAcc.entries()].sort((a, b) => a[0] - b[0])) {
				if (!entry.name) continue; // never got a name fragment — nothing usable to call
				let args: Record<string, unknown>;
				try {
					args = entry.argsText ? JSON.parse(entry.argsText) : {};
				} catch {
					continue; // malformed arguments JSON — skip this one call, not fatal
				}
				yield { type: 'tool_call', id: entry.id ?? `call_${index}`, name: entry.name, arguments: args };
			}
			yield { type: 'done' };
		} finally {
			bridge.dispose();
		}
	}

	/** Best-effort — not every OpenAI-compatible endpoint implements /models
	 * well; a failure here must never take down the whole registry.
	 *
	 * F14-1: this used to have no timeout at all — health() right below it already used
	 * AbortSignal.timeout(connectMs), but this one didn't, so one unreachable provider could hang the
	 * whole /api/providers/models Promise.all indefinitely, independent of any filtering question.
	 * Also now captures `created` (the one extra field this endpoint's response reliably has across
	 * providers) as an age fallback for model-filter.ts when a model id isn't in the F14-2 catalog. */
	async listModels(): Promise<ModelInfo[]> {
		try {
			const res = await fetch(`${this.config.baseUrl}/models`, {
				headers: this.headers(),
				signal: AbortSignal.timeout(this.config.timeouts.connectMs)
			});
			if (!res.ok) return [];
			const body = (await res.json()) as { data?: { id: string; created?: number }[] };
			return (body.data ?? []).map((m) => ({
				id: m.id,
				ctx: 8192,
				caps: { tools: false, reasoning: false },
				...(typeof m.created === 'number' ? { created: m.created } : {})
			}));
		} catch (err) {
			logAppEvent({ kind: 'provider_error', provider: this.id, message: `listModels: ${describeNetworkError(err)}` });
			return [];
		}
	}

	async health(): Promise<ProviderHealth> {
		try {
			const res = await fetch(`${this.config.baseUrl}/models`, {
				headers: this.headers(),
				signal: AbortSignal.timeout(this.config.timeouts.connectMs)
			});
			if (res.status === 401 || res.status === 403) return 'auth_error';
			return res.ok ? 'ok' : 'unreachable';
		} catch (err) {
			logAppEvent({ kind: 'provider_error', provider: this.id, message: `health: ${describeNetworkError(err)}` });
			return 'unreachable';
		}
	}
}
