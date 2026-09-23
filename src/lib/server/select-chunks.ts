import type { RetrievedChunk, RetrieveResult } from '$lib/types';
import { normalizeLevel } from '../../../indexer/chunk';

/**
 * Coarse floor, NOT a relevance filter — measured, not guessed, and the
 * measurement is the point of this comment.
 *
 * Against the real index under bge-m3, cosine distances for genuinely
 * correct results ran 0.353-0.567 (worst: a thin math query), while results
 * from the wrong domain for the same queries ran 0.360-0.562. Those ranges
 * overlap almost completely, so no threshold can tell relevant from
 * irrelevant here; ranking does that job, not this constant. Deliberately
 * out-of-scope queries (French cuisine, Ottoman poetry, football) bottomed
 * out at 0.550-0.620, which is the only thing this value can usefully cut.
 *
 * Raised from 0.55, which was calibrated for nomic-embed-text: under bge-m3
 * that value sat INSIDE the band of correct results and would have returned
 * "kaynak bulunamadı" for every math question (correct matches at 0.551+).
 * 0.60 keeps every genuine match observed with headroom and still drops the
 * clearly-unrelated tail (0.605+). Note what it does not do: a nonsense
 * query can still come back with something, because its best match (0.550)
 * is closer than a real math answer. The guarantee that survives is the one
 * that matters — the model can only cite chunks retrieval actually returned
 * (see the generators' source_id validation), never invent a path.
 *
 * Changing EMBED_MODEL invalidates this number; re-measure before touching it.
 */
const DISTANCE_THRESHOLD = 0.6;
const MAX_CHUNKS_PER_FILE = 3;
const DEFAULT_K = 8;

/** A KNN match already joined with its chunk/file metadata — everything
 * selectChunks() needs, with no DB or embedding dependency. */
export interface CandidateChunk {
	path: string;
	heading_path: string;
	display_text: string;
	topic: string;
	depth: string;
	domains: string[];
	distance: number;
	/** 'keyword' = found by the FTS fallback: `distance` is meaningless, so the
	 * threshold is skipped; every other filter still applies. */
	via?: 'keyword';
}

function inScope(filePath: string, includedPaths: string[]): boolean {
	return includedPaths.some((p) => filePath === p || filePath.startsWith(`${p}/`));
}

/** Same exact-or-subpath match as inScope, opposite polarity — a file
 * matching one of these prefixes is dropped regardless of includedPaths.
 * Used for LibrarySettings.hiddenFolders (raw/cards/frontier/... — see
 * library.ts's DEFAULT_SETTINGS): those are the vault's own bookkeeping,
 * never real study content, and every chunk that slipped through here was
 * a citation the user couldn't actually learn from — see report/quiz/cards
 * generators' anti-hallucination checks, which only verify a cited path
 * came FROM retrieval, not that retrieval itself was sensible. */
function isExcluded(filePath: string, excludedPrefixes: string[]): boolean {
	return excludedPrefixes.some((p) => filePath === p || filePath.startsWith(`${p}/`));
}

/**
 * Pure post-processing over an already-fetched candidate pool: distance
 * threshold, scope filter, domain filter, per-file dedupe, k-limit, and the
 * narrowScope determination. Kept dependency-free (no better-sqlite3, no
 * $env) on purpose — retrieve.ts's own imports pull in $env/dynamic/private
 * transitively via ./ollama, which only resolves inside a SvelteKit/Vite
 * run, not under plain `tsx --test`. This module is what retrieve.test.ts
 * actually exercises.
 */
export function selectChunks(
	candidates: CandidateChunk[],
	opts: {
		domains?: string[];
		levels?: string[];
		includedPaths?: string[];
		excludedPrefixes?: string[];
		k?: number;
	} = {}
): RetrieveResult {
	const k = opts.k ?? DEFAULT_K;
	const perFileCount = new Map<string, number>();
	const results: RetrievedChunk[] = [];
	let sawInThresholdOutOfScope = false;

	for (const c of candidates) {
		if (c.via !== 'keyword' && c.distance > DISTANCE_THRESHOLD) continue;

		// Checked before includedPaths and unconditionally (not gated on
		// includedPaths being set): a hidden folder must disappear from
		// retrieval the same way it disappears from SourceTree.svelte,
		// regardless of whether the user has also scoped the chat further.
		// Never sets sawInThresholdOutOfScope — "kapsamı genişlet?" wouldn't
		// help here, the content is administratively excluded, not just
		// out of the user's chosen scope.
		if (opts.excludedPrefixes?.length && isExcluded(c.path, opts.excludedPrefixes)) continue;

		if (opts.includedPaths !== undefined && !inScope(c.path, opts.includedPaths)) {
			sawInThresholdOutOfScope = true;
			continue;
		}

		// Case-insensitive — matches list_sources's SQL-side `lower(d.value) =
		// lower(?)`. Before this, search_library's domain filter was the only
		// one of the two that was case-sensitive: `domain=Databases` returned
		// 8 real matches from list_sources and 0 from search_library, for the
		// same vault and the same domain string (Ö7).
		if (opts.domains?.length && !opts.domains.some((d) => c.domains.some((cd) => cd.toLowerCase() === d.toLowerCase()))) {
			continue;
		}

		// Case-insensitive AND synonym-folded (normalizeLevel), because
		// frontmatter's level/depth field is hand-written, not an enum: a
		// caller (or Claude) can reasonably type "undergraduate" and expect it
		// to match a chunk stored as the canonical "undergrad" (Ö7 — an old
		// index that predated normalizeLevel stored the alias literally,
		// which no query-side case fold alone could bridge).
		if (
			opts.levels?.length &&
			!opts.levels.some((l) => normalizeLevel(l).toLowerCase() === normalizeLevel(c.depth).toLowerCase())
		) {
			continue;
		}

		const count = perFileCount.get(c.path) ?? 0;
		if (count >= MAX_CHUNKS_PER_FILE) continue;
		perFileCount.set(c.path, count + 1);

		results.push({
			path: c.path,
			heading_path: c.heading_path,
			display_text: c.display_text,
			topic: c.topic,
			depth: c.depth,
			domains: c.domains,
			distance: c.distance,
			...(c.via ? { via: c.via } : {})
		});
		if (results.length >= k) break;
	}

	const narrowScope = results.length === 0 && sawInThresholdOutOfScope;
	return {
		chunks: results,
		narrowScope,
		reason: results.length === 0 ? (narrowScope ? 'scope' : 'filtered') : undefined
	};
}
