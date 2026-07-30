import { OpenAICompatAdapter, type Timeouts } from './openai-compat';
import type { ChatRequest, Chunk, ModelInfo } from './types';
import { sharedJobMutex } from '../jobMutex';

/** Conservative defaults for unknown models; known families get better
 * numbers so the settings UI (later) can show real context/capability
 * info instead of guessing. */
const MODEL_FAMILY_TABLE: Record<string, { ctx: number; caps: { tools: boolean; reasoning: boolean } }> = {
	qwen3: { ctx: 40960, caps: { tools: true, reasoning: true } },
	'nomic-embed-text': { ctx: 2048, caps: { tools: false, reasoning: false } }
};
const DEFAULT_MODEL_INFO = { ctx: 8192, caps: { tools: false, reasoning: false } };

function modelInfoFor(name: string): ModelInfo {
	const family = Object.keys(MODEL_FAMILY_TABLE).find((f) => name.startsWith(f));
	const info = family ? MODEL_FAMILY_TABLE[family] : DEFAULT_MODEL_INFO;
	return { id: name, ...info };
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
	private currentModel: string | null = null;

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

	/** Ensures the swap discipline runs before every single chat, not just
	 * when a caller remembers to call ensureModelLoaded() themselves. */
	override async *chat(req: ChatRequest, signal: AbortSignal): AsyncGenerator<Chunk> {
		await this.ensureModelLoaded(req.model);
		yield* super.chat(req, signal);
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
	 * modified dates), mapped through the family table for ctx/caps. */
	async listModels(): Promise<ModelInfo[]> {
		return (await this.listNativeModels()).map((m) => modelInfoFor(m.name));
	}

	/** Full native /api/tags response, for callers (the settings model
	 * picker) that need size/modified_at — info the cross-provider ModelInfo
	 * shape deliberately doesn't carry. */
	async listNativeModels(): Promise<{ name: string; size: number; modified_at: string }[]> {
		const res = await fetch(`${this.nativeBaseUrl}/api/tags`);
		if (!res.ok) throw new Error(`Ollama /api/tags ${res.status}`);
		const data = (await res.json()) as {
			models?: { name: string; size: number; modified_at: string }[];
		};
		return data.models ?? [];
	}

	async unload(model: string): Promise<void> {
		await fetch(`${this.nativeBaseUrl}/api/chat`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ model, messages: [], keep_alive: 0 })
		}).catch(() => {
			// best-effort — if Ollama's already down there's nothing to unload
		});
	}

	async pull(model: string, onProgress?: (status: string) => void): Promise<void> {
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
				const { status } = JSON.parse(line) as { status?: string };
				if (status) onProgress?.(status);
			}
		}
	}

	/**
	 * 32 GB fits ONE large model — never let e.g. 8B and 30B-A3B coexist in
	 * RAM. Swapping (and Faz 5's document conversion, via the same shared
	 * mutex) always waits its turn rather than racing for RAM/CPU.
	 */
	async ensureModelLoaded(model: string): Promise<void> {
		if (this.currentModel === model) return;
		await sharedJobMutex.run(async () => {
			if (this.currentModel && this.currentModel !== model) {
				await this.unload(this.currentModel);
			}
			this.currentModel = model;
		});
	}
}
