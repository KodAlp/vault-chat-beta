import fs from 'node:fs';
import path from 'node:path';
import type { RequestHandler } from './$types';
import { resolveLibraryPath } from '#lib/server/library-read.js';
import { ATTACHMENT_EXT, META_DIR, ATTACHMENTS_SUBDIR, sniffAttachmentContentType } from '#lib/server/attachments.js';
import { vaultFromUrl } from '#lib/server/requestVault.js';
import { AppError, fail } from '#lib/server/app-error.js';
import { storeUploadedImage, MAX_IMAGE_UPLOAD_BYTES } from '#lib/server/attachment-upload.js';
import { vaultFromId } from '#lib/server/requestVault.js';

const ATTACHMENT_PREFIX = `${META_DIR}/${ATTACHMENTS_SUBDIR}/`;

/**
 * Binary file service for Görsel B — serves only files under
 * `_meta/attachments/`, never an arbitrary library path. Narrower than
 * reusing /api/library/file's traversal guard alone would be: this route
 * hands back raw bytes with a browser-trusted Content-Type, so its blast
 * radius is deliberately capped to the one folder that's meant for that
 * (markdown source content has no business being served this way).
 */
export const GET: RequestHandler = async ({ url }) => {
	const v = vaultFromUrl(url);
	const rel = url.searchParams.get('path');
	if (!rel) fail('VALIDATION_REQUIRED', { field: 'path' });

	let abs: string;
	try {
		abs = resolveLibraryPath(v, rel);
	} catch {
		fail('PATH_OUTSIDE_LIBRARY');
	}
	// resolveLibraryPath already confirmed abs is inside the library root;
	// this confirms it's specifically inside the attachments subfolder.
	const relNormalized = rel.replace(/\\/g, '/').replace(/^\/+/, '');
	if (!relNormalized.startsWith(ATTACHMENT_PREFIX)) fail('NOT_FOUND', { entity: 'file' }, 404);

	const ext = path.extname(abs).toLowerCase();
	if (!ATTACHMENT_EXT.has(ext)) fail('NOT_FOUND', { entity: 'file' }, 404);

	let buf: Buffer;
	try {
		buf = fs.readFileSync(abs);
	} catch {
		fail('NOT_FOUND', { entity: 'file' }, 404);
	}

	const contentType = sniffAttachmentContentType(ext, buf);
	if (!contentType) fail('ATTACHMENT_TYPE_MISMATCH', undefined, 415);

	return new Response(new Uint8Array(buf), {
		headers: {
			'Content-Type': contentType,
			// Immutable in practice — copyAttachmentIntoLibrary never overwrites
			// an existing destination name, so a cached response never goes stale.
			'Cache-Control': 'private, max-age=31536000, immutable'
		}
	});
};

/**
 * Image upload for the note editor (multipart: `file`, optional `vault`).
 * Type comes from the bytes, never the name/MIME; size is checked from
 * File.size before the body is read. Returns the library-root-relative path
 * `_meta/attachments/up_<sha16>.<ext>` for the editor to link to.
 */
export const POST: RequestHandler = async ({ request }) => {
	const form = await request.formData();
	const file = form.get('file');
	if (!(file instanceof File)) fail('VALIDATION_REQUIRED', { field: 'file' });
	if (file.size > MAX_IMAGE_UPLOAD_BYTES) {
		fail('FILE_TOO_LARGE', { limitMb: Math.round(MAX_IMAGE_UPLOAD_BYTES / (1024 * 1024)) }, 413);
	}
	const vaultField = form.get('vault');
	const v = vaultFromId(typeof vaultField === 'string' && vaultField ? vaultField : null);
	let rel: string;
	try {
		rel = storeUploadedImage(v, Buffer.from(await file.arrayBuffer()));
	} catch (e) {
		if (e instanceof AppError) fail(e.code, e.params, e.status);
		throw e;
	}
	return new Response(JSON.stringify({ path: rel }), { headers: { 'Content-Type': 'application/json' } });
};
