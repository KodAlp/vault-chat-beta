/**
 * Standalone Ollama client for the indexer. Deliberately does NOT reuse
 * src/lib/server/ollama.ts — that file imports $env/dynamic/private, a SvelteKit
 * virtual module that only exists inside the Vite/SvelteKit runtime. The indexer
 * runs as a plain `tsx` script outside that runtime (see vault-rag-index skill:
 * "indexer/ uygulamadan bağımsız").
 *
 * It does reuse env.ts's ollamaUrl(), which has no Vite dependency (plain
 * process.env, already used by the MCP server under the same constraint) —
 * and matters for a reason beyond not duplicating the default: ollamaUrl()
 * reads process.env.OLLAMA_URL lazily, on every call. A module-level
 * `const OLLAMA_URL = process.env.OLLAMA_URL ?? '...'` here used to capture
 * that value once, at import time — and index-vault.ts's static `import
 * { embedDocuments } from './embed'` (which pulls this module in) is
 * hoisted and evaluated *before* index-vault.ts's own top-level
 * `process.loadEnvFile()` call runs (K3). A custom OLLAMA_URL in .env was
 * silently ignored; every `npm run index` embedded against localhost:11434
 * regardless of what .env said.
 */
import { ollamaUrl } from '../src/lib/server/env';

export async function embed(texts: string[], model: string): Promise<number[][]> {
	const res = await fetch(`${ollamaUrl()}/api/embed`, {
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
