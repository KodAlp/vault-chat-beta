import { OpenAICompatAdapter, type Timeouts, classifyHttpStatus } from './openai-compat';
import { ProviderError, type ChatRequest, type ChatMessage, type Chunk, type ModelInfo, type ToolDefinition } from './types';
import { ollamaGate } from './ollama-gate';
import { parseOllamaDone, type OllamaDoneLine } from './ollama-usage';
import { serveCtxOverride } from '../env';
import { capsFor as tableCapsFor, lookupFamily, modelInfoFor, type ModelCapsOverride } from './model-caps';

/** /api/chat's NDJSON stream is newline-delimited, same as the base class's
 * SSE line splitting — a plain regex literal here (openai-compat.ts's own
 * split, for reference) rather than a string, to sidestep quoting. */
const NEWLINE_RE = /\n/;

const DEFAULT_SERVE_CTX = 8192;

function serveCtxFor(name: string): number {
	// OLLAMA_SERVE_CTX (env.ts) wins over the table: the table's numbers were
	// measured for qwen3:8b Q4_K_M, and a smaller quantization frees VRAM the
	// table knows nothing about. serveCtx is an Ollama num_ctx concern only, which is why it is read here
	// and not from model-caps.ts's shared helpers.
	const override = serveCtxOverride();
	if (override !== undefined) return override;
	const info = lookupFamily(name);
	return info?.serveCtx ?? info?.ctx ?? DEFAULT_SERVE_CTX;
}

/** Ollama's native /api/chat wire format, confirmed against the upstream
 * docs — deliberately NOT the same shape as our internal ChatMessage:
 * assistant tool_calls carry no `id` (Ollama has none — call identity is
 * purely positional/by-name), and a tool-result message is matched back by
 * `tool_name`, not an OpenAI-style `tool_call_id`. Our internal ChatMessage
 * type is OpenAI-shaped (id + tool_call_id) because openai-compat.ts's wire
 * format needs that; this function is the one place that downgrades it to
 * what Ollama actually understands. */
function toOllamaWireMessages(messages: ChatMessage[]): unknown[] {
	return messages.map((m) => {
		if (m.role === 'assistant' && m.tool_calls?.length) {
			return {
				role: 'assistant',
				content: m.content,
				tool_calls: m.tool_calls.map((tc) => ({ function: { name: tc.name, arguments: tc.arguments } }))
			};
		}
		if (m.role === 'tool') {
			return { role: 'tool', content: m.content, tool_name: m.name };
		}
		return { role: m.role, content: m.content };
	});
}

function toOllamaWireTools(tools: ToolDefinition[]): unknown[] {
	return tools.map((t) => ({
		type: 'function',
		function: { name: t.name, description: t.description, parameters: t.parameters }
	}));
}

/**
 * Extends the generic OpenAI-compat adapter (chat() routes through Ollama's
 * /v1 surface, sharing all the timeout/error/reasoning-normalization
 * machinery with every cloud provider) with the Ollama-specific bits: native
 * /api/tags for richer model listing, /api/pull for downloads, and
 * keep_alive-based unload for the single-large-model-in-RAM discipline.
 */
export class OllamaAdapter extends OpenAICompatAdapter {
	private nativeBaseUrl: string;
	private modelCapsOverride: Record<string, ModelCapsOverride> | undefined;

	constructor(id: string, nativeBaseUrl: string, timeouts: Timeouts, modelCaps?: Record<string, ModelCapsOverride>) {
		super({
			id,
			baseUrl: `${nativeBaseUrl.replace(/\/$/, '')}/v1`,
			// Empirically confirmed against a real running Ollama instance: its
			// /v1 surface streams reasoning as a structured `reasoning` delta
			// field, never inline <think> tags — despite that being the commonly
			// assumed behavior (and this class's own think-tag fallback exists
			// for exactly that assumption). Trust the real wire format, not the
			// assumption; normalize.ts's think-tag parser stays as defense in
			// depth for any Ollama build/config that does inline tags.
			reasoningDialect: 'reasoning_content',
			timeouts
		});
		this.nativeBaseUrl = nativeBaseUrl.replace(/\/$/, '');
		this.modelCapsOverride = modelCaps;
	}

	/** Synchronous, no network call — a pure lookup against model-caps.ts's table plus the provider's
	 * per-model override. Lets the chat route decide whether to attach tools
	 * to a request without an extra /api/tags round trip per message. */
	capsFor(model: string): { tools: boolean; reasoning: boolean } {
		return tableCapsFor(model, this.modelCapsOverride?.[model]);
	}

	/** Whether a partial assistant answer can be continued for this model — a
	 * pure lookup like capsFor. False for every family that was not verified. */
	supportsPrefixResume(model: string): boolean {
		return lookupFamily(model)?.prefixResume === true;
	}

	/** The gate's lease spans the whole stream, not just the swap moment
	 * before it — see ollama-gate.ts's doc comment for why that matters.
	 *
	 * A network/connect-timeout failure here is rethrown untouched (kind and
	 * providerId unchanged) rather than reworded — Ollama-not-running is this
	 * product's single most likely failure mode, but the actionable phrasing
	 * for it now lives client-side as its own code (api/chat/+server.ts's
	 * catch block special-cases a ProviderError with providerId 'ollama' and
	 * kind network/timeout_connect into `OLLAMA_UNREACHABLE`), not baked into
	 * this adapter's message text. */
	override async *chat(req: ChatRequest, signal: AbortSignal): AsyncGenerator<Chunk> {
		yield* ollamaGate.withModelStream(req.model, () => this.chatNative(req, signal));
	}

	/**
	 * Talks to native /api/chat instead of routing through the inherited
	 * /v1 surface (super.chat()) — /v1/chat/completions silently ignores
	 * options.num_ctx, empirically confirmed against a real running Ollama
	 * instance (`ollama ps` still reported 4096 after passing 16384 through
	 * options on /v1; the same request against /api/chat loaded the model at
	 * 16384). A real chat that motivated this fix truncated 2 of 6 turns from
	 * the front — where the system prompt's rules live — because the model
	 * never asked to load at anything but Ollama's 4096 default.
	 *
	 * Reuses the base class's abort/timeout-bridge and HTTP-status
	 * classification (now protected/exported for exactly this) rather than
	 * duplicating that machinery; only the request shape and the response
	 * parser differ, since /api/chat streams newline-delimited JSON objects
	 * (`{message: {content, thinking}, done}`), not SSE `data:` lines.
	 */
	private async *chatNative(req: ChatRequest, signal: AbortSignal): AsyncGenerator<Chunk> {
		const { connectMs, firstTokenMs, idleMs } = this.config.timeouts;
		// Once, so the window we ask for and the window the usage chunk reports
		// cannot drift apart.
		const numCtx = serveCtxFor(req.model);
		const bridge = this.makeAbortBridge(signal);
		bridge.armTimer(connectMs, 'timeout_connect');

		let res: Response;
		try {
			res = await fetch(`${this.nativeBaseUrl}/api/chat`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					model: req.model,
					messages: toOllamaWireMessages(req.messages),
					stream: true,
					// Native shape: a raw JSON Schema object, not /v1's wrapped
					// {type, json_schema:{name, schema}}.
					...(req.format ? { format: req.format } : {}),
					...(req.think !== undefined ? { think: req.think } : {}),
					...(req.tools?.length ? { tools: toOllamaWireTools(req.tools) } : {}),
					options: {
						num_ctx: numCtx,
						...(req.stop?.length ? { stop: req.stop } : {}),
						...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
						...(req.maxOutputTokens !== undefined ? { num_predict: req.maxOutputTokens } : {})
					}
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
				`HTTP ${res.status} — ${bodyText.slice(0, 300)}`
			);
		}

		bridge.armTimer(firstTokenMs, 'timeout_first_token');

		const reader = res.body.getReader();
		const decoder = new TextDecoder();
		let buffer = '';

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
				const lines = buffer.split(NEWLINE_RE);
				buffer = lines.pop() ?? '';

				for (const line of lines) {
					const trimmed = line.trim();
					if (!trimmed) continue;

					let json: {
						message?: {
							content?: string;
							thinking?: string;
							tool_calls?: { function: { name: string; arguments: Record<string, unknown> } }[];
						};
					} & OllamaDoneLine;
					try {
						json = JSON.parse(trimmed);
					} catch {
						continue; // a stray partial/non-JSON line — ignore, not fatal
					}
					// The final line carries the token counts and timings. Read it
					// before the `message` guard below so this never depends on that
					// line also having a message.
					const usage = parseOllamaDone(json, numCtx);
					if (usage) yield usage;
					const message = json.message;
					if (!message) continue;
					if (message.thinking) yield { type: 'reasoning', text: message.thinking };
					if (message.content) yield { type: 'text', text: message.content };
					// Ollama sends the whole tool_calls array in one line, not
					// fragmented across chunks like OpenAI's delta.tool_calls —
					// no accumulation needed, just synthesize a call id (Ollama's
					// own wire format has none; toOllamaWireMessages drops it
					// again when this round-trips back as a tool-result message).
					if (message.tool_calls) {
						for (let i = 0; i < message.tool_calls.length; i++) {
							const tc = message.tool_calls[i];
							yield { type: 'tool_call', id: `call_${i}`, name: tc.function.name, arguments: tc.function.arguments ?? {} };
						}
					}
				}
			}
			yield { type: 'done' };
		} finally {
			bridge.dispose();
		}
	}

	protected override extraBody(req: ChatRequest): Record<string, unknown> {
		// Non-standard OpenAI field, Ollama-specific: qwen3-family models
		// default reasoning ON even when omitted (see the original ollama.ts's
		// doc comment, preserved here) — pass through explicitly so
		// `think: false` (fast mode) actually suppresses it. Structured output
		// (req.format) is handled generically by the base class via the
		// standard response_format shape — confirmed that's what this Ollama
		// build actually honors on /v1, not a raw `format` field passthrough.
		return req.think !== undefined ? { think: req.think } : {};
	}

	/** Native /api/tags — richer than the generic /models list (sizes,
	 * modified dates), mapped through the family table for ctx/caps. Timed
	 * out like every other native call here — Ollama TCP-hung (not just
	 * connection-refused) otherwise leaves the settings model picker
	 * waiting forever, since openai-compat.ts's three-tier timeout only
	 * covers the /v1 chat surface, not these native endpoints. */
	async listModels(): Promise<ModelInfo[]> {
		return (await this.listNativeModels()).map((m) => modelInfoFor(m.name, this.modelCapsOverride?.[m.name]));
	}

	/** Full native /api/tags response, for callers (the settings model
	 * picker) that need size/modified_at — info the cross-provider ModelInfo
	 * shape deliberately doesn't carry. */
	async listNativeModels(): Promise<{ name: string; size: number; modified_at: string }[]> {
		const res = await fetch(`${this.nativeBaseUrl}/api/tags`, {
			signal: AbortSignal.timeout(this.config.timeouts.connectMs)
		});
		if (!res.ok) throw new Error(`Ollama /api/tags ${res.status}`);
		const data = (await res.json()) as {
			models?: { name: string; size: number; modified_at: string }[];
		};
		return data.models ?? [];
	}

	async delete(model: string): Promise<void> {
		const res = await fetch(`${this.nativeBaseUrl}/api/delete`, {
			method: 'DELETE',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ model }),
			signal: AbortSignal.timeout(this.config.timeouts.connectMs)
		});
		if (!res.ok) {
			const bodyText = await res.text().catch(() => '');
			throw new Error(`Ollama /api/delete ${res.status} — ${bodyText.slice(0, 200)}`);
		}
	}

	async pull(model: string, onProgress?: (status: string) => void): Promise<void> {
		// No fixed timeout here, unlike the other native calls below — a
		// model download can legitimately run for minutes, and a flat
		// connectMs signal covers the whole fetch lifetime, not just the
		// initial connect, so it would abort a healthy multi-GB download.
		const res = await fetch(`${this.nativeBaseUrl}/api/pull`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ model, stream: true })
		});
		if (!res.ok || !res.body) throw new Error(`Ollama /api/pull ${res.status}`);
		const reader = res.body.getReader();
		const decoder = new TextDecoder();
		let buffer = '';
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split('\n');
			buffer = lines.pop() ?? '';
			for (const line of lines) {
				if (!line.trim()) continue;
				// One malformed/truncated line (Ollama occasionally interleaves
				// a partial write) must not kill an otherwise-healthy download —
				// skip it and keep reading, same as openai-compat.ts's SSE parser.
				try {
					const { status } = JSON.parse(line) as { status?: string };
					if (status) onProgress?.(status);
				} catch {
					continue;
				}
			}
		}
	}
}
