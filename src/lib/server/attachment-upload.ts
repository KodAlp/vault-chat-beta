import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { attachmentsDir, META_DIR, ATTACHMENTS_SUBDIR, sniffAttachmentContentType } from './attachments';
import { AppError } from './app-error';
import type { VaultContext } from './vaults';

/** Largest image the editor may upload. Checked against File.size before the body is read. */
export const MAX_IMAGE_UPLOAD_BYTES = 10 * 1024 * 1024;

/**
 * Raster formats only. SVG is deliberately refused even though the serving
 * route can sniff it: its safety check is a regex deny-list, which is fine as
 * defense in depth for already-stored files but too weak to accept new
 * script-capable markup from an upload.
 */
const IMAGE_TYPES: { ext: string; mime: string }[] = [
	{ ext: '.png', mime: 'image/png' },
	{ ext: '.jpg', mime: 'image/jpeg' },
	{ ext: '.gif', mime: 'image/gif' },
	{ ext: '.webp', mime: 'image/webp' }
];

/** Real type of the bytes (never the client-supplied name or MIME), or null. */
export function sniffImageUpload(buf: Buffer): { ext: string; mime: string } | null {
	for (const t of IMAGE_TYPES) {
		if (sniffAttachmentContentType(t.ext, buf) === t.mime) return t;
	}
	return null;
}

/**
 * Stores an uploaded image in the vault's shared attachments folder as
 * `up_<sha16>.<ext>` (content-addressed: the same bytes always land on the
 * same name, so re-uploading is a no-op). The `up_` prefix keeps it outside
 * converted-image cleanup, which only ever considers bare `<sha16>.<ext>` names.
 * The name is derived from the bytes alone, so no client string reaches a path.
 * Returns the library-root-relative path.
 */
export function storeUploadedImage(v: VaultContext, bytes: Buffer): string {
	if (bytes.length === 0) throw new AppError('VALIDATION_REQUIRED', { field: 'file' });
	if (bytes.length > MAX_IMAGE_UPLOAD_BYTES) {
		throw new AppError('FILE_TOO_LARGE', { limitMb: Math.round(MAX_IMAGE_UPLOAD_BYTES / (1024 * 1024)) }, 413);
	}
	const type = sniffImageUpload(bytes);
	if (!type) throw new AppError('ATTACHMENT_TYPE_MISMATCH', undefined, 415);
	const name = `up_${crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 16)}${type.ext}`;
	const dir = attachmentsDir(v);
	fs.mkdirSync(dir, { recursive: true });
	try {
		fs.writeFileSync(path.join(dir, name), bytes, { flag: 'wx' });
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
	}
	return [META_DIR, ATTACHMENTS_SUBDIR, name].join('/');
}
