import { OpenAICompatAdapter, type Timeouts, classifyHttpStatus } from './openai-compat';
import { ProviderError, type ChatRequest, type Chunk, type ModelInfo } from './types';
import { ollamaGate } from './ollama-gate';

/** /api/chat's NDJSON stream is newline-delimited, same as the base class's
 * SSE line splitting — a plain regex literal here (openai-compat.ts's own
 * split, for reference) rather than a string, to sidestep quoting. */
const NEWLINE_RE = /\n/;

/** Conservative defaults for unknown models; known families get better
 * numbers so the settings UI (later) can show real context/capability
 * info instead of guessing. */
interface FamilyInfo {
	ctx: number;
	caps: { tools: boolean; reasoning: boolean };
	/** What chat() actually requests via options.num_ctx — see chat()'s doc
	 * comment. Defaults to `ctx` when omitted (a model with no reason to
	 * cap below its real max). */
	serveCtx?: number;
	/** See ModelInfo.embeddingOnly — marks a family as unusable for chat. */
	embeddingOnly?: boolean;
}
const MODEL_FAMILY_TABLE: Record<string, FamilyInfo> = {
	// 40960 is qwen3:8b's real max, but serving at its full max costs VRAM
	// (~4.2GB at 16384 already) for headroom this app's prompts don't need —
	// the failing real chat that motivated this table peaked at ~4.6k tokens
	// including retrieved context and thinking. 16384 clears that with room
	// to spare without paying for context the model will not use.
	qwen3: { ctx: 40960, serveCtx: 16384, caps: { tools: true, reasoning: true } },
	'nomic-embed-text': { ctx: 2048, caps: { tools: false, reasoning: false }, embeddingOnly: true },
	// EMBED_MODEL (embed-config.ts) — Ollama's /api/tags lists it right next
	// to chat models with no way to tell them apart otherwise, and picking
	// it in a chat/generation model selector silently fails (no chat
	// template). See the bge-m3 bug report this table entry fixes.
	'bge-m3': { ctx: 8192, caps: { tools: false, reasoning: false }, embeddingOnly: true }
};
const DEFAULT_MODEL_INFO = { ctx: 8192, caps: { tools: false, reasoning: false } };
const DEFAULT_SERVE_CTX = 8192;

function modelInfoFor(name: string): ModelInfo {
	const family = Object.keys(MODEL_FAMILY_TABLE).find((f) => name.startsWith(f));
	const info = family ? MODEL_FAMILY_TABLE[family] : DEFAULT_MODEL_INFO;
	return { id: name, ...info };
}

function serveCtxFor(name: string): number {
	const family = Object.keys(MODEL_FAMILY_TABLE).find((f) => name.startsWith(f));
	const info = family ? MODEL_FAMILY_TABLE[family] : undefined;
	return info?.serveCtx ?? info?.ctx ?? DEFAULT_SERVE_CTX;
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

	constructor(id: string, nativeBaseUrl: string, timeouts: Timeouts) {
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
	}

	/** The gate's lease spans the whole stream, not just the swap moment
	 * before it — see ollama-gate.ts's doc comment for why that matters. */
	override async *chat(req: ChatRequest, signal: AbortSignal): AsyncGenerator<Chunk> {
		try {
			yield* ollamaGate.withModelStream(req.model, () => this.chatNative(req, signal));
		} catch (err) {
			// The base class's connection-refused/hung-server message
			// ("ollama: ağ hatası — fetch failed") is technically accurate but
			// not actionable — settings/+page.svelte already has the right
			// phrasing for this exact failure mode ("Model listesi alınamadı —
			// Ollama çalışıyor mu?"); the chat path should read the same way,
			// since Ollama-not-running is this product's single most likely
			// failure mode, not an edge case.
			if (err instanceof ProviderError && (err.kind === 'network' || err.kind === 'timeout_connect')) {
				throw new ProviderError(err.kind, err.providerId, `${err.providerId}: Ollama'ya ulaşılamıyor — Ollama çalışıyor mu?`);
			}
			throw err;
		}
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
		const bridge = this.makeAbortBridge(signal);
		bridge.armTimer(connectMs, 'timeout_connect');

		let res: Response;
		try {
			res = await fetch(`${this.nativeBaseUrl}/api/chat`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					model: req.model,
					messages: req.messages,
					stream: true,
					// Native shape: a raw JSON Schema object, not /v1's wrapped
					// {type, json_schema:{name, schema}}.
					...(req.format ? { format: req.format } : {}),
					...(req.think !== undefined ? { think: req.think } : {}),
					options: {
						num_ctx: serveCtxFor(req.model),
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
				`${this.id}: HTTP ${res.status} — ${bodyText.slice(0, 300)}`
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

					let json: { message?: { content?: string; thinking?: string }; done?: boolean };
					try {
						json = JSON.parse(trimmed);
					} catch {
						continue; // a stray partial/non-JSON line — ignore, not fatal
					}
					const message = json.message;
					if (!message) continue;
					if (message.thinking) yield { type: 'reasoning', text: message.thinking };
					if (message.content) yield { type: 'text', text: message.content };
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
		return (await this.listNativeModels()).map((m) => modelInfoFor(m.name));
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
