import { env } from '$env/dynamic/private';

const OLLAMA_URL = env.OLLAMA_URL ?? 'http://localhost:11434';

/**
 * Embeddings are explicitly out of scope for the provider layer
 * (src/lib/server/providers/) — the embedding model is part of the index
 * configuration (sqlite-vec metadata), not a chat-completion concern. This
 * is the only thing left in this file; chat/model-listing moved to
 * providers/ollama.ts.
 */
export async function embed(texts: string[], model: string): Promise<number[][]> {
	const res = await fetch(`${OLLAMA_URL}/api/embed`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ model, input: texts })
	});
	if (!res.ok) throw new Error(`Ollama /api/embed ${res.status}`);
	const data = (await res.json()) as { embeddings: number[][] };
	return data.embeddings;
}
