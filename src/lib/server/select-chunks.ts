import type { RetrievedChunk, RetrieveResult } from '$lib/types';

const DISTANCE_THRESHOLD = 0.55;
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
		if (c.distance > DISTANCE_THRESHOLD) continue;

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

		if (opts.domains?.length && !opts.domains.some((d) => c.domains.includes(d))) continue;

		// Faz 10's search_library MCP tool — case-insensitive because
		// frontmatter's level/depth field is hand-written, not an enum.
		if (opts.levels?.length && !opts.levels.some((l) => l.toLowerCase() === c.depth.toLowerCase())) {
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
			distance: c.distance
		});
		if (results.length >= k) break;
	}

	return {
		chunks: results,
		narrowScope: results.length === 0 && sawInThresholdOutOfScope
	};
}
