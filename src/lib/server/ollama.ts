import { ollamaUrl } from './env';
import { ollamaGate } from './providers/ollama-gate';

/**
 * Embeddings are explicitly out of scope for the provider layer
 * (src/lib/server/providers/) — the embedding model is part of the index
 * configuration (sqlite-vec metadata), not a chat-completion concern. This
 * is the only thing left in this file; chat/model-listing moved to
 * providers/ollama.ts.
 *
 * Uses env.ts's process.env accessor, not $env/dynamic/private — this is
 * the one module on the MCP server's (mcp/) read path (via retrieve.ts),
 * which runs outside Vite and can't resolve $env. See the mcp-server skill.
 *
 * Routed through ollamaGate like every other Ollama RAM access — it used to
 * bypass the single-large-model discipline entirely (Faz 11 audit finding).
 * nomic-embed-text is declared resident there, so this never waits on or
 * triggers a chat-model swap; it only keeps the gate's ledger honest.
 *
 * That gate exemption only covers the app's own bookkeeping — Ollama's
 * scheduler still has to fit both models in VRAM. On a 6 GB card it cannot
 * (qwen3:8b alone is ~4.2 GB of the ~4.5 GiB Ollama budgets), so a GPU-resident
 * bge-m3 evicted the chat model on every retrieval and the chat model was
 * reloaded (~5 s, `loadMs` in the llm_timing log) on the next line of the same
 * turn — measured ~9 s of overhead per turn. `cpuOnly` keeps the embed model
 * out of VRAM (`num_gpu: 0`) so both stay resident: measured 0.2 s per query
 * embedding and ~0.6 s to the chat model instead of ~10 s, with query vectors
 * identical to the GPU ones (cosine >= 0.999999 over 16 queries).
 */
export interface EmbedOptions {
	/** Run the embedding model on the CPU only. Meant for per-query embedding,
	 * where the tiny input makes CPU cost negligible; leave it off for bulk
	 * indexing (incrementalIndex.ts), where GPU throughput matters. */
	cpuOnly?: boolean;
}

export async function embed(texts: string[], model: string, opts: EmbedOptions = {}): Promise<number[][]> {
	return ollamaGate.withModel(model, async () => {
		const res = await fetch(`${ollamaUrl()}/api/embed`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ model, input: texts, ...(opts.cpuOnly ? { options: { num_gpu: 0 } } : {}) })
		});
		if (!res.ok) throw new Error(`Ollama /api/embed ${res.status}`);
		const data = (await res.json()) as { embeddings: number[][] };
		return data.embeddings;
	});
}
