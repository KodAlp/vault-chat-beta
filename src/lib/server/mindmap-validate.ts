import { MindMapTreeSchema } from './mindmap-schema';
import type { NewMindMapNode } from './study-db';

/**
 * Pure validation + flattening for a mind-map response, split out of
 * generate-mindmap.ts for the same reason select-chunks.ts was split out of
 * retrieve.ts: generate-mindmap.ts pulls in providers/registry ->
 * $env/dynamic/private, which only resolves inside a SvelteKit/Vite run, so
 * nothing in it can be exercised under plain `tsx --test`. Everything here is
 * dependency-free and is what mindmap-validate.test.ts actually runs.
 */

/** Cited chunk, as the server knows it — the model only ever names the id. */
export interface CitedChunk {
	path: string;
	heading_path: string;
}

export interface MindMapResult {
	rootLabel: string;
	rootSummary: string;
	nodes: NewMindMapNode[];
	/** Labels dropped for being a source file name — surfaced so the caller can
	 * write a debug trail. Never shown to the user. */
	droppedFileNameLabels: string[];
}

export type MindMapParseResult =
	| { ok: true; result: MindMapResult }
	| { ok: false; error: string };

/** Long summaries are trimmed rather than rejected: the JSON Schema cannot
 * enforce string length through llama.cpp's GBNF conversion, and a slightly
 * long explanation is not a reason to throw away a whole generation. This is
 * the authoritative limit — mindmap-schema.ts carries the same number as a
 * best-effort brake inside the grammar, but only this one always applies. */
const MAX_SUMMARY_CHARS = 450;

/** Below this the map is not worth showing, so dropping file-name nodes can
 * still turn into a hard failure. */
const MIN_NODES = 3;

const FILE_EXT_RE = /\.(md|pdf|txt|html?|docx?|pptx?)$/i;

/**
 * A citation id the model tacked onto the label text instead of leaving it
 * in the source_id field — observed in a real generation as
 * "Calculus Foundations (S13)".
 *
 * Moving to a nested schema killed the old failure where an id became its
 * own label, but not this one: here the id is INSIDE the string, so the
 * schema cannot see it. Stripped rather than rejected — the id carries
 * nothing the label needs, and the concept underneath it is perfectly good.
 */
const TRAILING_ID_RE = /[\s([]*\bS\d+\b[)\]]*\s*$/;

function cleanLabel(label: string): string {
	// Falls back to the original when stripping would empty the label — a
	// node literally called "S3" is a different problem, and an empty string
	// would be a worse answer than the useless-but-visible one.
	return label.replace(TRAILING_ID_RE, '').trim() || label.trim();
}

/** Basename of a library path, with and without extension, so a label can be
 * compared against both "corbett-2012-spanner.md" and "corbett-2012-spanner". */
function baseNames(path: string): string[] {
	const base = path.split('/').pop() ?? path;
	return [base, base.replace(FILE_EXT_RE, '')];
}

function trimSummary(text: string): string {
	const clean = text.trim();
	return clean.length > MAX_SUMMARY_CHARS ? `${clean.slice(0, MAX_SUMMARY_CHARS - 1)}…` : clean;
}

/**
 * The user's rule is absolute: a source's own name must NEVER appear as a node
 * label. It is enforced by DELETING the offending node (and its subtree, which
 * hangs off a label the user was never supposed to see) rather than by failing
 * the generation.
 *
 * That split is deliberate and was learned the expensive way: an earlier
 * version made every quality rule a hard rejection, and across three live runs
 * it burned the whole retry budget and produced NO map at all. Dropping keeps
 * the guarantee and still hands the user something. Checked against every
 * retrieved path, not only the one a node cites, because the model will
 * happily name a node after a file it did not cite.
 */
function isFileNameLabel(label: string, fileNames: ReadonlySet<string>): boolean {
	const clean = label.trim();
	return FILE_EXT_RE.test(clean) || fileNames.has(clean.toLowerCase());
}

interface RawNode {
	label: string;
	summary: string;
	source_id: string;
	children?: RawNode[];
}

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
	const parsed = MindMapTreeSchema.safeParse(json);
	if (!parsed.success) {
		return { ok: false, error: parsed.error.issues.map((i) => i.message).join('; ') };
	}
	const tree = parsed.data;

	// Hard failure: a citation the server never offered means the map is
	// dishonest, and no amount of cleanup can make it honest.
	const unknownIds: string[] = [];
	const collectIds = (raws: RawNode[]) => {
		for (const n of raws) {
			if (!idToChunk.has(n.source_id)) unknownIds.push(n.source_id);
			if (n.children) collectIds(n.children);
		}
	};
	collectIds(tree.branches as RawNode[]);
	if (unknownIds.length > 0) {
		return {
			ok: false,
			error: `${unknownIds.length} düğümün source_id'si sağlanan kaynak kimlikleriyle eşleşmiyor. Sadece S1, S2, ... gibi verilen kimlikleri kullan.`
		};
	}

	const fileNames = new Set(
		[...idToChunk.values()].flatMap((c) => baseNames(c.path).map((b) => b.toLowerCase()))
	);
	const dropped: string[] = [];
	const nodes: NewMindMapNode[] = [];

	const walk = (raws: RawNode[], parentPath: string[]) => {
		for (const n of raws) {
			const label = cleanLabel(n.label);
			if (isFileNameLabel(label, fileNames)) {
				dropped.push(label);
				continue; // subtree goes with it — it hangs off a forbidden label
			}
			const path = [...parentPath, label];
			const chunk = idToChunk.get(n.source_id)!;
			nodes.push({
				path,
				summary: trimSummary(n.summary),
				source_path: chunk.path,
				heading_path: chunk.heading_path
			});
			if (n.children?.length) walk(n.children, path);
		}
	};
	walk(tree.branches as RawNode[], []);

	if (nodes.length < MIN_NODES) {
		return {
			ok: false,
			error: `Temizlik sonrası sadece ${nodes.length} düğüm kaldı (en az ${MIN_NODES} gerekli). Düğüm etiketleri dosya adı değil, kavram olmalı.`
		};
	}

	return {
		ok: true,
		result: {
			rootLabel: cleanLabel(tree.root.label),
			rootSummary: trimSummary(tree.root.summary),
			nodes,
			droppedFileNameLabels: dropped
		}
	};
}

/**
 * SOFT quality assessment: returns a corrective hint, or null when the map
 * looks like a real concept map.
 *
 * These are NOT failures. An earlier version made them hard gates and three
 * consecutive live runs each exhausted the retry budget on a different rule,
 * leaving the user with an error instead of a map. Unlike a fabricated
 * citation, none of these makes the artifact dishonest — so the caller retries
 * on a hint while attempts remain, then accepts the last hard-valid answer.
 */
export function assessMindMapQuality(
	result: MindMapResult,
	idToChunk: Map<string, CitedChunk>
): string | null {
	const { nodes } = result;

	// A map with no depth is a list, and the hierarchy IS the artifact.
	if (!nodes.some((n) => n.path.length >= 2)) {
		return 'Ağaç tek seviyeli — her dalın altına o dalı oluşturan alt kavramları da ekle.';
	}

	// One branch is an outline of a single idea, not a map of the topic.
	const branches = new Set(nodes.map((n) => n.path[0]));
	if (branches.size < 2) {
		return 'Harita tek bir ana daldan oluşuyor. Konuyu 3-6 farklı ana başlığa ayır.';
	}

	const availableSources = new Set([...idToChunk.values()].map((c) => c.path));
	const usedSources = new Set(nodes.map((n) => n.source_path));
	if (availableSources.size > 1 && usedSources.size < 2) {
		return `Harita tek bir kaynağa dayanıyor ama ${availableSources.size} farklı kaynak verildi. En az iki farklı kaynağı ilişkilendir.`;
	}

	return null;
}
