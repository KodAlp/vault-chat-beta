import { ALLOWED_EXTENSIONS, CODE_EXTENSIONS, MAX_UPLOAD_BYTES } from './import-extensions';

/**
 * The ONE place that decides whether a file found in a picked folder is worth
 * importing. Used by BatchImport (browser folder picks, where the file
 * list comes from webkitRelativePath) and by the server folder scan
 * (folder-scan.ts, the Linux desktop picker), so the two cannot drift apart.
 * Pure and isomorphic on purpose: no fs, no $lib alias (the test runner cannot
 * resolve it).
 *
 * The server still re-checks everything when it imports a file; this is the
 * preview / pre-filter, never the security boundary.
 */

/** Directory levels below the picked root that are still looked at. */
export const MAX_SCAN_DEPTH = 20;
/** Most entries one folder scan may return. */
export const MAX_SCAN_ENTRIES = 10_000;

export type SkipReason = 'junk' | 'tooLarge' | 'unsupported' | 'tooDeep';

const IMPORTABLE_EXTENSIONS = new Set([...ALLOWED_EXTENSIONS, ...CODE_EXTENSIONS]);

export function extOf(name: string): string {
	const i = name.lastIndexOf('.');
	return i === -1 ? '' : name.slice(i).toLowerCase();
}

/** Hidden names (a leading dot: .git, .obsidian, .DS_Store), macOS zip junk
 * (__MACOSX) and Windows shell files. Applies to every path segment, so a
 * junk folder anywhere in a picked tree is skipped as a whole. */
export function isJunkName(name: string): boolean {
	const lower = name.toLowerCase();
	return name.startsWith('.') || lower === '__macosx' || lower === 'desktop.ini' || lower === 'thumbs.db';
}

export function isImportableExtension(ext: string): boolean {
	return IMPORTABLE_EXTENSIONS.has(ext.toLowerCase());
}

/** `relPath` is relative to the picked root (the root folder name itself is
 * not part of it), with / or \ separators. Returns why the file is skipped,
 * or null when it should be imported. */
export function skipReasonFor(relPath: string, size: number): SkipReason | null {
	const segments = relPath.split(/[\\/]+/).filter(Boolean);
	if (segments.length === 0) return 'junk';
	if (segments.length - 1 > MAX_SCAN_DEPTH) return 'tooDeep';
	if (segments.some(isJunkName)) return 'junk';
	if (size > MAX_UPLOAD_BYTES) return 'tooLarge';
	if (!isImportableExtension(extOf(segments[segments.length - 1]))) return 'unsupported';
	return null;
}
