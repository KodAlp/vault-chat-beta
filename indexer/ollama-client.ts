/**
 * Standalone Ollama client for the indexer. Deliberately does NOT reuse
 * src/lib/server/ollama.ts — that file imports $env/dynamic/private, a SvelteKit
 * virtual module that only exists inside the Vite/SvelteKit runtime. The indexer
 * runs as a plain `tsx` script outside that runtime (see vault-rag-index skill:
 * "indexer/ uygulamadan bağımsız"), so it reads process.env directly instead.
 */
const OLLAMA_URL = process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434';

export async function embed(texts: string[], model: string): Promise<number[][]> {
	const res = await fetch(`${OLLAMA_URL}/api/embed`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ model, input: texts })
	});
	if (!res.ok) {
		throw new Error(`Ollama /api/embed ${res.status} — "ollama serve" çalışıyor mu?`);
	}
	const data = (await res.json()) as { embeddings: number[][] };
	return data.embeddings;
}
