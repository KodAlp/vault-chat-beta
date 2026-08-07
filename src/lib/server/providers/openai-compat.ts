import { ProviderError, type ProviderErrorKind } from './types';
import type { ProviderAdapter, ChatRequest, Chunk, ModelInfo, ProviderHealth } from './types';
import { createThinkTagNormalizer, reasoningContentChunk, textChunk } from './normalize';

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

function classifyHttpStatus(status: number, bodyText: string): ProviderErrorKind {
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
 * Generic adapter for any OpenAI-compatible /chat/completions endpoint —
 * covers every cloud provider plus Ollama (via its own /v1 surface, see
 * providers/ollama.ts). One implementation, one set of timeout/error/
 * reasoning-normalization semantics, per the skill's "one interface,
 * provider adapters underneath" rule.
 */
export class OpenAICompatAdapter implements ProviderAdapter {
	readonly id: string;
	protected config: OpenAICompatConfig;

	constructor(config: OpenAICompatConfig) {
		this.id = config.id;
		this.config = config;
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
	private makeAbortBridge(externalSignal: AbortSignal) {
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

	private toProviderError(err: unknown, externalSignal: AbortSignal, timeoutKind: ProviderErrorKind | null): unknown {
		// A genuine caller-initiated abort (stop button, inflight supersede) is
		// not a provider failure — rethrow it as-is so callers keep treating
		// AbortError as "cancelled", exactly like today's ollama.ts does.
		if (externalSignal.aborted && !timeoutKind) return err;
		if (timeoutKind) {
			return new ProviderError(timeoutKind, this.id, `${this.id}: zaman aşımı (${timeoutKind})`);
		}
		return new ProviderError('network', this.id, `${this.id}: ağ hatası — ${err instanceof Error ? err.message : String(err)}`);
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
					messages: req.messages,
					stream: true,
					...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
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

		if (!res.ok || !res.body) {
			const bodyText = await res.text().catch(() => '');
			bridge.dispose();
			throw new ProviderError(
				classifyHttpStatus(res.status, bodyText),
				this.id,
				`${this.id}: HTTP ${res.status} — ${bodyText.slice(0, 300)}`
			);
		}

		bridge.armTimer(firstTokenMs, 'timeout_first_token');

		const reader = res.body.getReader();
		const decoder = new TextDecoder();
		let buffer = '';
		const thinkNormalizer =
			this.config.reasoningDialect === 'think-tags' ? createThinkTagNormalizer() : null;

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
							{ delta?: { content?: string; reasoning_content?: string; reasoning?: string } }
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
				}
			}
			if (thinkNormalizer) {
				for (const chunk of thinkNormalizer.flush()) yield chunk;
			}
			yield { type: 'done' };
		} finally {
			bridge.dispose();
		}
	}

	/** Best-effort — not every OpenAI-compatible endpoint implements /models
	 * well; a failure here must never take down the whole registry. */
	async listModels(): Promise<ModelInfo[]> {
		try {
			const res = await fetch(`${this.config.baseUrl}/models`, { headers: this.headers() });
			if (!res.ok) return [];
			const body = (await res.json()) as { data?: { id: string }[] };
			return (body.data ?? []).map((m) => ({
				id: m.id,
				ctx: 8192,
				caps: { tools: false, reasoning: false }
			}));
		} catch {
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
		} catch {
			return 'unreachable';
		}
	}
}
