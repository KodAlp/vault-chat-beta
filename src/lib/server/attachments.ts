import fs from 'node:fs';
import path from 'node:path';
import { libraryRoot } from './library';
import type { VaultContext } from './vaults';

/** Same set importObsidian.ts used privately before this module existed —
 * moved here so the image-serving route (Görsel B) and any future ingest
 * step (docling, Görsel A's real-image arm) share one allowlist instead of
 * drifting into two. */
export const ATTACHMENT_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.pdf', '.webp']);

export const META_DIR = '_meta';
export const ATTACHMENTS_SUBDIR = 'attachments';

/** Flat shared folder, not per-note-relative: library docs move to different
 * relative paths than their source (import, rename), so a copy tied to the
 * note that first referenced it would break on any later move. */
export function attachmentsDir(v: VaultContext): string {
	return path.join(libraryRoot(v), META_DIR, ATTACHMENTS_SUBDIR);
}

/**
 * Copies `srcAbs` into the vault's shared attachments folder under `base`
 * (its destination file name) and returns the library-root-relative path
 * (`_meta/attachments/<base>`) a caller can turn into a markdown image link.
 * Returns null for an extension outside ATTACHMENT_EXT — callers decide
 * whether that's a silent skip (importObsidian's current behavior) or a
 * reported error.
 *
 * Idempotent by destination name, not content hash: a second call with the
 * same `base` is a no-op if the file already exists (same as the original
 * importObsidian.ts logic this was extracted from). That is only correct
 * while `base` identifies the content. Obsidian import passes the vault's own
 * attachment names (content-addressed-ish); converted documents
 * (converted-images.ts) pass `<sha16>.<ext>`, the first 16 hex chars of the
 * sha256 of the exact bytes, so the same name always means the same bytes.
 * A future caller with free-form names from different sources would need its
 * own disambiguation before calling this.
 */
export function copyAttachmentIntoLibrary(v: VaultContext, srcAbs: string, base: string): string | null {
	const ext = path.extname(base).toLowerCase();
	if (!ATTACHMENT_EXT.has(ext)) return null;
	const dir = attachmentsDir(v);
	fs.mkdirSync(dir, { recursive: true });
	const destAbs = path.join(dir, base);
	if (!fs.existsSync(destAbs)) {
		fs.copyFileSync(srcAbs, destAbs);
	}
	return [META_DIR, ATTACHMENTS_SUBDIR, base].join('/');
}

const SVG_UNSAFE_RE = /<script|on\w+\s*=|javascript:/i;

/**
 * Never trust the extension alone for what a binary route serves back to a
 * browser (a `.png` file can contain anything a hand-crafted request wants
 * it to). Checks the file's actual leading bytes against the extension's
 * claimed family and returns the Content-Type to serve, or null to reject —
 * the caller (the /api/library/attachment route) must refuse the request on
 * null rather than fall back to a guessed type.
 *
 * SVG is the one text-based case here: its "magic bytes" are just well-
 * formed-enough XML, which is a weak signal, so this also rejects one
 * containing a <script> tag, an on*= event handler, or a javascript: URI —
 * defense in depth alongside the app's script-src 'self' CSP (which already
 * blocks inline script in a directly-navigated SVG document, but should not
 * be the only layer for content this route serves from user-supplied files).
 */
export function sniffAttachmentContentType(ext: string, buf: Buffer): string | null {
	switch (ext) {
		case '.png':
			return buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
				? 'image/png'
				: null;
		case '.jpg':
		case '.jpeg':
			return buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff ? 'image/jpeg' : null;
		case '.gif':
			return buf.length >= 6 && (buf.subarray(0, 6).toString('ascii') === 'GIF87a' || buf.subarray(0, 6).toString('ascii') === 'GIF89a')
				? 'image/gif'
				: null;
		case '.webp':
			return buf.length >= 12 &&
				buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
				buf.subarray(8, 12).toString('ascii') === 'WEBP'
				? 'image/webp'
				: null;
		case '.pdf':
			return buf.length >= 5 && buf.subarray(0, 5).toString('ascii') === '%PDF-' ? 'application/pdf' : null;
		case '.svg': {
			// First 2KB is plenty to find an XML/<svg opening tag; unsafe-content
			// check runs over the whole file since a <script> could be anywhere.
			const head = buf.subarray(0, 2048).toString('utf-8');
			if (!/<svg[\s>]/i.test(head)) return null;
			return SVG_UNSAFE_RE.test(buf.toString('utf-8')) ? null : 'image/svg+xml';
		}
		default:
			return null;
	}
}
