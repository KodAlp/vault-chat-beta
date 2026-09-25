import { foldToSlug } from './slug';
import { EXCLUDED_DIRS } from '../../../indexer/excluded-dirs';

/** Deeper source trees are flattened at this depth rather than rejected. */
export const MAX_BATCH_SUBDIR_DEPTH = 6;

/**
 * Batch import (folder pick): turns the directory part of a browser
 * `File.webkitRelativePath` — already stripped of the picked folder's own
 * name, which becomes the domain — into library subdirectory segments, so
 * `Matematik/kaynaklar/0_Kalkulus1/x.pdf` lands in
 * `<domain>/kaynaklar/0-kalkulus1/`.
 *
 * The value is client-supplied, so this is the first of two traversal
 * guards (resolveLibraryPath is the second): `.`/`..`/empty segments are
 * dropped, never resolved, and every segment is ascii-folded. A segment that
 * folds to an indexer-excluded name (`raw`, `attachments`, `templates`…)
 * gets a suffix — left as-is, every note under it would be written and then
 * silently never indexed.
 */
export function relDirToSegments(relDir: string): string[] {
	const segments: string[] = [];
	for (const part of relDir.split(/[\\/]+/)) {
		if (part === '' || part === '.' || part === '..') continue;
		let seg = foldToSlug(part, '');
		if (!seg) continue;
		if (EXCLUDED_DIRS.has(seg)) seg = `${seg}-klasoru`;
		segments.push(seg);
		if (segments.length === MAX_BATCH_SUBDIR_DEPTH) break;
	}
	return segments;
}
