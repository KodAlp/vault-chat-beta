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
	opts: { domains?: string[]; includedPaths?: string[]; k?: number } = {}
): RetrieveResult {
	const k = opts.k ?? DEFAULT_K;
	const perFileCount = new Map<string, number>();
	const results: RetrievedChunk[] = [];
	let sawInThresholdOutOfScope = false;

	for (const c of candidates) {
		if (c.distance > DISTANCE_THRESHOLD) continue;

		if (opts.includedPaths?.length && !inScope(c.path, opts.includedPaths)) {
			sawInThresholdOutOfScope = true;
			continue;
		}

		if (opts.domains?.length && !opts.domains.some((d) => c.domains.includes(d))) continue;

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
