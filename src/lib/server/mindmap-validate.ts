import { MindMapNodes } from './mindmap-schema';
import type { NewMindMapNode } from './study-db';

/**
 * Pure validation for a mind-map model response, split out of
 * generate-mindmap.ts for exactly the reason select-chunks.ts was split out
 * of retrieve.ts: generate-mindmap.ts pulls in providers/registry ->
 * $env/dynamic/private, which only resolves inside a SvelteKit/Vite run, so
 * nothing in it can be exercised under plain `tsx --test`. Everything here
 * is dependency-free and is what mindmap-validate.test.ts actually runs.
 */

/** Cited chunk, as the server knows it — the model only ever names the id. */
export interface CitedChunk {
	path: string;
	heading_path: string;
}

export type MindMapParseResult =
	| { ok: true; nodes: NewMindMapNode[] }
	| { ok: false; error: string };

/** Trailing punctuation/whitespace and case are not a meaningful difference
 * between a label and the heading it was copied from. */
function normalizeLabel(text: string): string {
	return text.trim().toLowerCase().replace(/[\s.:;,—–-]+$/u, '');
}

/** Matches the S1/S2 citation-id shape, to keep it out of node labels. */
const ID_RE = /^S\d+$/;

/** Floor on map size, clamped to how many chunks were actually retrieved —
 * see the check below for why a floor is needed at all. */
export const MIN_NODES = 6;

/** Last segment of an "A > B > C" heading chain. */
function lastHeadingSegment(headingPath: string): string {
	const parts = headingPath.split('>');
	return parts[parts.length - 1] ?? headingPath;
}

/**
 * Schema validity is not enough here: a schema-valid map can still be a
 * worthless one, and every rule below corresponds to a failure actually
 * observed in this install's output rather than a hypothetical.
 *
 * - id-shaped labels: the model confuses "cite this id" with "name the node
 *   after it" and emits path: ["S4", "..."].
 * - copied headings: labels that are verbatim copies of the chunk's own
 *   heading make the map the source's table of contents re-rendered as a
 *   tree, not a concept map — nothing was synthesized. Checked as a MAJORITY,
 *   since one coincidence is plausible and an all-or-nothing rule just burns
 *   retries on otherwise fine output.
 * - single source: a map drawn from one file when retrieval offered several
 *   is the model latching onto the first source instead of relating them,
 *   which is the one thing a mind map is for.
 * - node floor: without it the rules above have a trivial escape hatch —
 *   emit two nodes from two sources and everything passes.
 *
 * Each failure goes through generate-mindmap.ts's MAX_RETRIES loop, whose
 * retry prompt feeds `error` back to the model as a correction hint, so the
 * messages are written to be actionable rather than merely descriptive.
 */
export function parseAndValidateMindMap(
	raw: string,
	idToChunk: Map<string, CitedChunk>
): MindMapParseResult {
	let json: unknown;
	try {
		json = JSON.parse(raw);
	} catch {
		return { ok: false, error: 'Model geçerli JSON döndürmedi.' };
	}
	const result = MindMapNodes.safeParse(json);
	if (!result.success) {
		return { ok: false, error: result.error.issues.map((i) => i.message).join('; ') };
	}
	const nodes = result.data.nodes;
	if (nodes.length === 0) {
		return { ok: false, error: 'Model hiç düğüm üretmedi.' };
	}

	const unknownIds = nodes.filter((n) => !idToChunk.has(n.source_id));
	if (unknownIds.length > 0) {
		return {
			ok: false,
			error: `${unknownIds.length} düğümün source_id'si sağlanan kaynak kimlikleriyle eşleşmiyor. Sadece S1, S2, ... gibi verilen kimlikleri kullan.`
		};
	}

	const idShapedLabels = nodes.filter((n) => n.path.some((label) => ID_RE.test(label.trim())));
	if (idShapedLabels.length > 0) {
		return {
			ok: false,
			error: `${idShapedLabels.length} düğümün path'inde S1/S2 gibi bir kaynak kimliği var. Kimlik sadece source_id alanına yazılır; path yalnızca kavram etiketlerinden oluşur.`
		};
	}

	const copiedHeadings = nodes.filter((n) => {
		const chunk = idToChunk.get(n.source_id)!;
		const leaf = n.path[n.path.length - 1];
		return normalizeLabel(leaf) === normalizeLabel(lastHeadingSegment(chunk.heading_path));
	});
	if (copiedHeadings.length * 2 >= nodes.length) {
		const example = copiedHeadings[0].path[copiedHeadings[0].path.length - 1];
		return {
			ok: false,
			error: `${copiedHeadings.length}/${nodes.length} düğümün etiketi kaynağın başlığının kopyası (ör. "${example}"). Etiketler kaynağın içindekiler tablosu değil, kendi cümlenle yazdığın kavram/mekanizma/iddia olmalı.`
		};
	}

	const availableSources = new Set([...idToChunk.values()].map((c) => c.path));
	const usedSources = new Set(nodes.map((n) => idToChunk.get(n.source_id)!.path));
	if (availableSources.size > 1 && usedSources.size < 2) {
		return {
			ok: false,
			error: `Harita tek bir kaynağa dayanıyor ama ${availableSources.size} farklı kaynak verildi. En az iki farklı kaynağı ilişkilendir.`
		};
	}

	const minNodes = Math.min(MIN_NODES, idToChunk.size);
	if (nodes.length < minNodes) {
		return {
			ok: false,
			error: `Harita sadece ${nodes.length} düğüm içeriyor. En az ${minNodes} düğüm üret ve dallara ayır.`
		};
	}

	return {
		ok: true,
		nodes: nodes.map((n) => {
			const chunk = idToChunk.get(n.source_id)!;
			return { path: n.path, source_path: chunk.path, heading_path: chunk.heading_path };
		})
	};
}
