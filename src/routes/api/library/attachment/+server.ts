import fs from 'node:fs';
import path from 'node:path';
import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { resolveLibraryPath } from '$lib/server/library-read';
import { ATTACHMENT_EXT, META_DIR, ATTACHMENTS_SUBDIR, sniffAttachmentContentType } from '$lib/server/attachments';
import { vaultFromUrl } from '$lib/server/requestVault';

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
	if (!rel) error(400, 'path gerekli');

	let abs: string;
	try {
		abs = resolveLibraryPath(v, rel);
	} catch {
		error(400, 'Geçersiz yol');
	}
	// resolveLibraryPath already confirmed abs is inside the library root;
	// this confirms it's specifically inside the attachments subfolder.
	const relNormalized = rel.replace(/\\/g, '/').replace(/^\/+/, '');
	if (!relNormalized.startsWith(ATTACHMENT_PREFIX)) error(404, 'Dosya bulunamadı');

	const ext = path.extname(abs).toLowerCase();
	if (!ATTACHMENT_EXT.has(ext)) error(404, 'Dosya bulunamadı');

	let buf: Buffer;
	try {
		buf = fs.readFileSync(abs);
	} catch {
		error(404, 'Dosya bulunamadı');
	}

	const contentType = sniffAttachmentContentType(ext, buf);
	if (!contentType) error(415, 'Dosya içeriği beklenen türle uyuşmuyor');

	return new Response(new Uint8Array(buf), {
		headers: {
			'Content-Type': contentType,
			// Immutable in practice — copyAttachmentIntoLibrary never overwrites
			// an existing destination name, so a cached response never goes stale.
			'Cache-Control': 'private, max-age=31536000, immutable'
		}
	});
};
