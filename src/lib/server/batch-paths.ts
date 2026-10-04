import { foldToSlug } from './slug';
import { EXCLUDED_DIRS } from '../../../indexer/excluded-dirs';

/** Deeper source trees are flattened at this depth rather than rejected. */
export const MAX_BATCH_SUBDIR_DEPTH = 6;

/** Per-segment cap: far below any filesystem's 255-byte name limit, which the
 * slug + ".md" filename and the full path must also fit under. */
export const MAX_BATCH_SEGMENT_LENGTH = 64;

/** Windows device names — a directory called `con` or `nul` is unusable on
 * Windows (reserved regardless of extension), and the slug fold maps
 * `CON`/`Nul` straight onto them. */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/;

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
		let seg = foldToSlug(part, '').slice(0, MAX_BATCH_SEGMENT_LENGTH).replace(/-+$/, '');
		if (!seg) continue;
		if (EXCLUDED_DIRS.has(seg) || WINDOWS_RESERVED.test(seg)) seg = `${seg}-klasoru`;
		segments.push(seg);
		if (segments.length === MAX_BATCH_SUBDIR_DEPTH) break;
	}
	return segments;
}
