import { embed } from './ollama-client';
import { EMBED_MODEL, DOC_PREFIX } from '../src/lib/server/embed-config';

const BATCH_SIZE = 32;

/** Sequential batches on purpose — Ollama shares GPU/RAM with the chat model. */
export async function embedDocuments(texts: string[]): Promise<number[][]> {
	const results: number[][] = [];
	for (let i = 0; i < texts.length; i += BATCH_SIZE) {
		const batch = texts.slice(i, i + BATCH_SIZE).map((t) => `${DOC_PREFIX}${t}`);
		const vectors = await embed(batch, EMBED_MODEL);
		results.push(...vectors);
	}
	return results;
}
