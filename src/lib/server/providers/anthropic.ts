import { ProviderError, type ProviderErrorKind } from './types';
import type { ProviderAdapter, ChatRequest, Chunk, ModelInfo, ProviderHealth } from './types';

export interface Timeouts {
	connectMs: number;
	firstTokenMs: number;
	idleMs: number;
}

export interface AnthropicConfig {
	id: string;
	apiKey?: string | null;
	timeouts: Timeouts;
}

const ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1';

function classifyHttpStatus(status: number, bodyText: string): ProviderErrorKind {
	if (status === 401 || status === 403) return 'auth';
	if (status === 429) return 'http_429';
	if (status >= 500) return 'http_5xx';
	if (status === 400) {
		return /maximum context|context.?length|too many tokens/i.test(bodyText)
			? 'context_length'
			: 'bad_request';
	}
	return 'unknown';
}

/**
 * Native Anthropic adapter (Faz 16B). Anthropic's Messages API is NOT
 * OpenAI-compatible — it uses its own request shape (system top-level field,
 * max_tokens required, messages with content blocks), its own streaming
 * format (event types like content_block_delta/message_stop, SSE with
 * `event:` lines), and its own reasoning representation (thinking blocks)
 * — so this is a standalone adapter implementing the same ProviderAdapter
 * interface, not a subclass of OpenAICompatAdapter.
 *
 * JSON-schema structured output (req.format) is mapped to Anthropic's
 * `tool_use`-based JSON mode (the documented way to get constrained
 * output); when no format is requested the regular free-text path is used.
 */
export class AnthropicAdapter implements ProviderAdapter {
	readonly id: string;
	private config: AnthropicConfig;

	constructor(config: AnthropicConfig) {
		this.id = config.id;
		this.config = config;
	}

	private headers(): Record<string, string> {
		const h: Record<string, string> = {
			'content-type': 'application/json',
			'x-api-key': this.config.apiKey ?? '',
			'anthropic-version': '2023-06-01'
		};
		return h;
	}

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
		if (externalSignal.aborted && !timeoutKind) return err;
		if (timeoutKind) {
			return new ProviderError(timeoutKind, this.id, `${this.id}: zaman aşımı (${timeoutKind})`);
		}
		return new ProviderError('network', this.id, `${this.id}: ağ hatası — ${err instanceof Error ? err.message : String(err)}`);
	}

	private buildBody(req: ChatRequest): Record<string, unknown> {
		// Anthropic's API has no separate system role — the system prompt is
		// a top-level `system` field, and messages carry only user/assistant.
		const systemMessages = req.messages.filter((m) => m.role === 'system');
		const system = systemMessages.length > 0 ? systemMessages.map((m) => m.content).join('\n\n') : undefined;

		const messages = req.messages
			.filter((m) => m.role !== 'system')
			.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }));

		const body: Record<string, unknown> = {
			model: req.model,
			max_tokens: 8192,
			messages,
			stream: true
		};
		if (system) body.system = system;
		if (req.temperature !== undefined) body.temperature = req.temperature;
		if (req.think !== false) {
			const hasUser = messages.some((m) => m.role === 'user');
			// The Anthropic extended-thinking budget must cover the generation.
			body.thinking = { type: 'enabled', budget_tokens: 4096 };
			// When thinking is enabled, max_tokens must be set and temperature
			// must be unset (Anthropic hard requirement).
			delete body.temperature;
			if (!hasUser) throw new Error('Anthropic thinking mode requires at least one user message');
		}

		// Structured output via tool_use JSON mode — Anthropic's documented
		// way to get constrained JSON from the model.
		if (req.format) {
			body.tools = [
				{
					name: 'output',
					description: 'Return the response as valid JSON matching the schema.',
					input_schema: {
						type: 'object',
						properties: {
							value: req.format ?? {}
						},
						required: ['value']
					}
				}
			];
			body.tool_choice = { type: 'tool', name: 'output' };
		}
		return body;
	}

	async *chat(req: ChatRequest, signal: AbortSignal): AsyncGenerator<Chunk> {
		const { connectMs, firstTokenMs, idleMs } = this.config.timeouts;
		const bridge = this.makeAbortBridge(signal);
		bridge.armTimer(connectMs, 'timeout_connect');

		let res: Response;
		try {
			res = await fetch(`${ANTHROPIC_BASE_URL}/messages`, {
				method: 'POST',
				headers: this.headers(),
				body: JSON.stringify(this.buildBody(req)),
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
		// Anthropic's SSE frames are TWO lines each ("event: TYPE" then
		// "data: PAYLOAD", blank-line separated) — the event type has to be
		// carried across the loop iteration boundary since buffer.split('\n')
		// below yields one LINE per element, not one whole frame. (A prior
		// version tried to re-split each already-single line by '\n' looking
		// for both parts on one line, which can never match anything — that
		// silently discarded every event, so this adapter streamed nothing.)
		let pendingEventType: string | null = null;
		let done = false;

		try {
			while (!done) {
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

				for (const rawLine of lines) {
					const line = rawLine.trim();
					if (!line) {
						pendingEventType = null;
						continue;
					}
					if (line.startsWith('event:')) {
						pendingEventType = line.slice('event:'.length).trim();
						continue;
					}
					if (!line.startsWith('data:') || !pendingEventType) continue;
					const payload = line.slice('data:'.length).trim();
					if (!payload) continue;

					let json: {
						type?: string;
						delta?: { type?: string; text?: string; thinking?: string };
						content_block?: { type?: string; text?: string; thinking?: string };
						message?: { stop_reason?: string };
					};
					try {
						json = JSON.parse(payload);
					} catch {
						continue;
					}

					// Anthropic streams content as content_block deltas:
					// - text blocks → text_chunk
					// - thinking blocks (reasoning) → reasoning
					if (pendingEventType === 'content_block_delta' && json.delta) {
						if (json.delta.type === 'thinking_delta' && json.delta.thinking) {
							yield { type: 'reasoning', text: json.delta.thinking };
						} else if (json.delta.type === 'text_delta' && json.delta.text) {
							yield { type: 'text', text: json.delta.text };
						}
					}
					if (pendingEventType === 'message_stop') {
						done = true;
						break;
					}
				}
			}
			yield { type: 'done' };
		} finally {
			bridge.dispose();
		}
	}

	async listModels(): Promise<ModelInfo[]> {
		// Anthropic doesn't expose a public model-list endpoint; the
		// Settings model picker already falls back to a static conservative
		// entry when listModels() returns [].
		try {
			const res = await fetch(`${ANTHROPIC_BASE_URL}/models`, {
				headers: this.headers(),
				signal: AbortSignal.timeout(this.config.timeouts.connectMs)
			});
			if (!res.ok) return [];
			const body = (await res.json()) as { data?: { id: string }[] };
			return (body.data ?? []).map((m) => ({
				id: m.id,
				ctx: 200_000,
				caps: { tools: true, reasoning: true }
			}));
		} catch {
			return [];
		}
	}

	async health(): Promise<ProviderHealth> {
		// /messages with a dummy request is the only reliable health signal;
		// a 401/403 means the key is wrong, anything else means reachable.
		try {
			const res = await fetch(`${ANTHROPIC_BASE_URL}/messages`, {
				method: 'POST',
				headers: this.headers(),
				body: JSON.stringify({
					model: 'claude-3-5-haiku-latest',
					max_tokens: 1,
					messages: [{ role: 'user', content: 'ping' }]
				}),
				signal: AbortSignal.timeout(this.config.timeouts.connectMs)
			});
			if (res.status === 401 || res.status === 403) return 'auth_error';
			return res.ok || res.status === 400 ? 'ok' : 'unreachable';
		} catch {
			return 'unreachable';
		}
	}
}