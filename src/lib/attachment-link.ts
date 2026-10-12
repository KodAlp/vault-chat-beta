/**
 * Pure path resolution for Görsel B, split out of markdown.ts for the same
 * reason mindmap-validate.ts was split out of generate-mindmap.ts: markdown.ts
 * imports `dompurify` (needs a real DOM/window) and `shiki`, neither of which
 * runs under plain `tsx --test` — this file has no such dependency, so it's
 * what attachment-link.test.ts actually exercises.
 */

/** Absolute URL (any scheme), protocol-relative, or root-relative — none of
 * these are a same-vault relative attachment link, so a caller should leave
 * them untouched rather than passing them to resolveRelativeLibraryPath. */
export const ABSOLUTE_SRC_RE = /^([a-z][a-z0-9+.-]*:|\/\/|\/)/i;

/**
 * Browser-safe POSIX path resolution (no node:path — this runs client-side
 * in the library viewer). Resolves a markdown image `src` that's relative to
 * `currentPath` (the viewed file's own library-root-relative path) into a
 * library-root-relative path, the same convention importObsidian.ts's
 * rewriteEmbeds uses when it *writes* such a link via
 * `path.relative(dirname(currentRel), destRel)` — this is that operation's
 * inverse.
 */
export function resolveRelativeLibraryPath(currentPath: string, src: string): string {
	const dirParts = currentPath.split('/').slice(0, -1);
	const stack: string[] = [...dirParts];
	for (const part of src.split('/')) {
		if (part === '' || part === '.') continue;
		if (part === '..') stack.pop();
		else stack.push(part);
	}
	return stack.join('/');
}

/**
 * Inverse of resolveRelativeLibraryPath: the markdown link from the note at
 * `currentPath` to the library-root-relative `targetRel`, with each segment
 * URL-encoded (the editor and viewer decodeURI the src before resolving it).
 */
export function relativeLibraryLink(currentPath: string, targetRel: string): string {
	const from = currentPath.split('/').slice(0, -1);
	const to = targetRel.split('/').filter((p) => p !== '' && p !== '.');
	let i = 0;
	while (i < from.length && i < to.length - 1 && from[i] === to[i]) i++;
	const parts = [...from.slice(i).map(() => '..'), ...to.slice(i)];
	return parts.map((p) => (p === '..' ? p : encodeURIComponent(p))).join('/');
}
