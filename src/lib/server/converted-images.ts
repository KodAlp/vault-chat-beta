import fs from 'node:fs';
import path from 'node:path';
import { copyAttachmentIntoLibrary, META_DIR, ATTACHMENTS_SUBDIR } from './attachments';
import { libraryRoot } from './library';
import { resolveRelativeLibraryPath, ABSOLUTE_SRC_RE } from '../attachment-link';
import type { VaultContext } from './vaults';

/**
 * "Images survive conversion": ingest/convert.py writes each picture of a
 * converted document to `<outDir>/images/<sha16>.<ext>` and refers to it as
 * `images/<sha16>.<ext>` in the Markdown (see ingest/images.py for the note
 * format). This module moves those files into the vault's shared
 * `_meta/attachments/` folder and rewrites the links relative to the note
 * that is about to be written.
 */

/** The only file names convert.py produces: 16 hex chars of the content hash
 * plus a re-encoded extension. Checked before any filesystem access — the
 * list comes from a child process's JSON, but a name is still never joined
 * into a path unvalidated. */
export const CONVERTED_IMAGE_NAME_RE = /^[0-9a-f]{16}\.(png|jpe?g)$/;

const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const ATTACH_PREFIX = `${META_DIR}/${ATTACHMENTS_SUBDIR}/`;
// `![alt](src)` or `![alt](src "title")`; alt may not contain `]` (convert.py strips it).
const IMAGE_LINK_RE = /(!\[[^\]\n]*\]\()([^)\s]+)((?:\s+"[^"\n]*")?\))/g;
const FENCE_RE = /^[ \t]*(`{3,}|~{3,})/;

/** Applies `fn` to every line outside fenced code blocks, so an example
 * `![x](images/a.png)` inside a code fence is never rewritten. */
function mapOutsideFences(md: string, fn: (line: string) => string): string {
	let fence: string | null = null;
	return md
		.split('\n')
		.map((line) => {
			const m = FENCE_RE.exec(line);
			if (m) {
				if (fence === null) fence = m[1][0];
				else if (m[1][0] === fence) fence = null;
				return line;
			}
			return fence === null ? fn(line) : line;
		})
		.join('\n');
}

function relativeLink(noteRel: string, targetRel: string, encoded: boolean): string {
	const rel = path.posix.relative(path.posix.dirname(noteRel), targetRel);
	return encoded ? rel.split('/').map(encodeURIComponent).join('/') : rel;
}

/**
 * Turns `images/<file>` image links into links relative to `noteRel` (the
 * note's library-root-relative path) pointing at `_meta/attachments/<file>`.
 * Only names accepted by `isKept` are rewritten; a link to an image that was
 * not (or could not be) copied is removed so the note never carries a dead
 * image. The `<!-- vc:gorsel -->` marker line is left in place.
 */
export function rewriteConvertedImageLinks(md: string, noteRel: string, isKept: (name: string) => boolean): string {
	return mapOutsideFences(md, (line) =>
		line.replace(IMAGE_LINK_RE, (whole, head: string, src: string, tail: string) => {
			if (!src.startsWith('images/')) return whole;
			const name = src.slice('images/'.length);
			if (!CONVERTED_IMAGE_NAME_RE.test(name)) return whole;
			if (!isKept(name)) return '';
			return `${head}${relativeLink(noteRel, ATTACH_PREFIX + name, false)}${tail}`;
		})
	);
}

/**
 * When a note moves from `fromRel` to `toRel` (staging -> final folder), every
 * relative image link that resolves into `_meta/attachments/` is rewritten so
 * it still resolves to the same file. Absolute/URL/data sources and links to
 * anything else are untouched.
 */
export function relinkAttachmentsForMove(md: string, fromRel: string, toRel: string): string {
	return mapOutsideFences(md, (line) =>
		line.replace(IMAGE_LINK_RE, (whole, head: string, src: string, tail: string) => {
			if (ABSOLUTE_SRC_RE.test(src) || src.startsWith('#')) return whole;
			let decoded = src;
			try {
				decoded = decodeURIComponent(src);
			} catch {
				return whole;
			}
			const resolved = resolveRelativeLibraryPath(fromRel, decoded);
			if (!resolved.startsWith(ATTACH_PREFIX)) return whole;
			return `${head}${relativeLink(toRel, resolved, src.includes('%'))}${tail}`;
		})
	);
}

/** Library-root-relative POSIX path of an absolute path inside the library. */
export function libraryRelPath(v: VaultContext, abs: string): string {
	return path.relative(libraryRoot(v), abs).split(path.sep).join('/');
}

/**
 * Copies the images a conversion produced into the vault and returns `md`
 * with links rewritten for `noteRel`. `outPath` is convert.py's `outPath`
 * (the images sit in `images/` next to it); `names` its `images` list. Call
 * this BEFORE the work directory is removed. Never throws for a bad image:
 * the picture is dropped and the text is kept.
 */
export function importConvertedImages(
	v: VaultContext,
	conversion: { outPath: string | null; images?: string[] },
	noteRel: string,
	md: string
): string {
	const kept = new Set<string>();
	if (conversion.outPath && conversion.images?.length) {
		const imagesDir = path.join(path.dirname(conversion.outPath), 'images');
		for (const name of conversion.images) {
			if (!CONVERTED_IMAGE_NAME_RE.test(name)) continue;
			try {
				const src = path.join(imagesDir, name);
				const st = fs.lstatSync(src);
				if (!st.isFile() || st.size === 0 || st.size > MAX_IMAGE_BYTES) continue;
				// Content-addressed name: an existing file of that name has these exact bytes.
				if (copyAttachmentIntoLibrary(v, src, name)) kept.add(name);
			} catch {
				// missing/unreadable image: dropped below
			}
		}
	}
	return rewriteConvertedImageLinks(md, noteRel, (name) => kept.has(name));
}
