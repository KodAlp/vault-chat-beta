import { Cards } from './cards-schema';
import type { NewCard } from './study-db';

/**
 * Pure validation for a card-generation model response, split out of
 * generate-cards.ts for the same reason mindmap-validate.ts was split out of
 * generate-mindmap.ts: generate-cards.ts pulls in providers/registry ->
 * $env/dynamic/private, which only resolves inside a SvelteKit/Vite run, so
 * nothing in it can be exercised under plain `tsx --test`. Everything here is
 * dependency-free and is what cards-validate.test.ts actually runs.
 */

/** Cited chunk, as the server knows it — the model only ever names the id. */
export interface CitedChunk {
	path: string;
	heading_path: string;
	domains: string[];
	depth: string;
}

export type CardsParseResult = { ok: true; items: NewCard[] } | { ok: false; error: string };

/**
 * Rejects items whose source_id isn't one of the ids actually offered — the
 * anti-hallucination check the skill requires — and, for the ones that pass,
 * resolves source_path/heading_path/domain/level from the server's own chunk
 * table rather than trusting the model to copy them.
 */
export function parseAndValidateCards(
	raw: string,
	idToChunk: Map<string, CitedChunk>,
	expectedCount: number
): CardsParseResult {
	let json: unknown;
	try {
		json = JSON.parse(raw);
	} catch {
		return { ok: false, error: 'Model geçerli JSON döndürmedi.' };
	}
	const result = Cards.safeParse(json);
	if (!result.success) {
		return { ok: false, error: result.error.issues.map((i) => i.message).join('; ') };
	}
	const badIds = result.data.items.filter((item) => !idToChunk.has(item.source_id));
	if (badIds.length > 0) {
		return {
			ok: false,
			error: `${badIds.length} kartın source_id'si sağlanan kaynak kimlikleriyle eşleşmiyor. Sadece S1, S2, ... gibi verilen kimlikleri kullan.`
		};
	}
	if (result.data.items.length !== expectedCount) {
		return {
			ok: false,
			error: `Model ${expectedCount} kart istenirken ${result.data.items.length} kart üretti. Tam olarak ${expectedCount} kart üret.`
		};
	}
	const items: NewCard[] = result.data.items.map((item) => {
		const chunk = idToChunk.get(item.source_id)!;
		return {
			front: item.front,
			back: item.back,
			source_path: chunk.path,
			heading_path: chunk.heading_path,
			domain: chunk.domains[0] ?? 'genel',
			level: chunk.depth
		};
	});
	return { ok: true, items };
}
