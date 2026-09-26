import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';

/**
 * Content-addressed golden-set anchors for RAG benchmark qrels.
 *
 * `chunks.id` is an AUTOINCREMENT surrogate key that gets reassigned on every
 * reindex, and (path, heading_path) is not unique (a heading can repeat, or a
 * note can be split into several chunks under the same heading). Neither is
 * stable enough to key a hand-labeled relevance judgment against, so labels
 * are keyed on a hash of the chunk's own content instead. As long as the
 * labeled text/heading/path survive a reindex byte-for-byte (modulo harmless
 * whitespace), the anchor survives with it.
 *
 * Free of `$lib` / `$env` imports on purpose: `bench/` runs under plain
 * `tsx`, outside SvelteKit's module resolution.
 */

export interface ChunkLike {
	path: string;
	heading_path: string;
	display_text: string;
}

/**
 * Collapses whitespace differences that don't change meaning — CRLF vs LF
 * line endings, doubled spaces, trailing/leading whitespace — and normalizes
 * to NFC so composed vs. decomposed Unicode (accented Turkish text, math
 * symbols) hash identically. This is what keeps an anchor stable across a
 * re-save of an unchanged note (different line-ending convention, an editor
 * that trims trailing spaces) while still changing when the actual content
 * changes.
 */
export function normalizeChunkText(s: string): string {
	return s.normalize('NFC').replace(/\r\n/g, '\n').replace(/\s+/g, ' ').trim();
}

/**
 * Content-addressed id for a chunk's (path, heading, text) triple. Truncated
 * to 12 hex chars (48 bits) — a benchmark golden set tops out at a few
 * thousand chunks, far below where birthday-bound collisions become a real
 * risk at that length, and a short id keeps qrels files/CSVs readable.
 */
export function chunkAnchor(chunk: ChunkLike): string {
	const hash = createHash('sha1')
		.update(chunk.path + '\u0000' + chunk.heading_path + '\u0000' + normalizeChunkText(chunk.display_text))
		.digest('hex');
	return 'a_' + hash.slice(0, 12);
}

export interface AnchorIndex {
	/** anchor -> every current chunk id that hashes to it (normally one; more
	 * than one means two chunks in the current index are byte-identical in
	 * path+heading+text, which resolveQrels treats as an ambiguous exact match). */
	byAnchor: Map<string, number[]>;
	byId: Map<number, { anchor: string; path: string; heading_path: string }>;
	/** The path of a still-present anchor, or undefined if it no longer exists. */
	pathOf(anchor: string): string | undefined;
}

interface ChunkRow {
	id: number;
	path: string;
	heading_path: string;
	display_text: string;
}

/**
 * Builds the anchor <-> chunk-id mapping for one snapshot of the index DB.
 * `db` must already be open — opening it read-only (or not) is the caller's
 * job; this function only ever SELECTs, never writes.
 */
export function buildAnchorIndex(db: Database.Database): AnchorIndex {
	const rows = db.prepare('SELECT id, path, heading_path, display_text FROM chunks').all() as ChunkRow[];
	const byAnchor = new Map<string, number[]>();
	const byId = new Map<number, { anchor: string; path: string; heading_path: string }>();
	const anchorPath = new Map<string, string>();
	for (const row of rows) {
		const anchor = chunkAnchor(row);
		const ids = byAnchor.get(anchor);
		if (ids) ids.push(row.id);
		else byAnchor.set(anchor, [row.id]);
		byId.set(row.id, { anchor, path: row.path, heading_path: row.heading_path });
		if (!anchorPath.has(anchor)) anchorPath.set(anchor, row.path);
	}
	return {
		byAnchor,
		byId,
		pathOf: (anchor: string) => anchorPath.get(anchor)
	};
}

export type QrelStatus = 'exact' | 'file-only' | 'missing';

export interface QrelLabel {
	anchor: string;
	path: string;
	grade: number;
}

export interface ResolvedQrel extends QrelLabel {
	status: QrelStatus;
}

/**
 * Resolves a golden-set label against a current index snapshot:
 * - 'exact': the anchor still exists — the labeled chunk is unchanged.
 * - 'file-only': the anchor is gone but the file still has chunks — the note
 *   was re-edited (heading renamed, text tweaked, re-chunked), not deleted.
 *   The label is stale, not necessarily wrong; a benchmark run typically
 *   reports these separately rather than silently scoring them as misses.
 * - 'missing': neither the anchor nor any chunk for the path exists — the
 *   file was deleted/renamed, or the vault was rebuilt from scratch.
 */
export function resolveQrels(relevant: QrelLabel[], index: AnchorIndex): ResolvedQrel[] {
	const pathsWithChunks = new Set<string>();
	for (const entry of index.byId.values()) pathsWithChunks.add(entry.path);
	return relevant.map((label) => {
		let status: QrelStatus;
		if (index.byAnchor.has(label.anchor)) status = 'exact';
		else if (pathsWithChunks.has(label.path)) status = 'file-only';
		else status = 'missing';
		return { ...label, status };
	});
}
