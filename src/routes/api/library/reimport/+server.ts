import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import matter from 'gray-matter';
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { enqueueConversion } from '#lib/server/convertQueue.js';
import { ocrLangArg } from '#lib/server/ocr-lang.js';
import { getLibrarySettings } from '#lib/server/library-read.js';
import { stagingDir, readLibraryFile, safeBasename, ALLOWED_EXTENSIONS, CODE_EXTENSIONS } from '#lib/server/library.js';
import { originalPathForSourceSha } from '#lib/server/originals.js';
import { importConvertedImages } from '#lib/server/converted-images.js';
import { buildReimportedNote } from '#lib/server/reimport.js';
import { vaultFromUrl, vaultFromId } from '#lib/server/requestVault.js';
import type { VaultContext } from '#lib/server/vaults.js';
import { sseStream } from '#lib/server/sse.js';
import { logAppEvent } from '#lib/server/app-log.js';
import { AppError, errorPayload, fail } from '#lib/server/app-error.js';
import type { ReimportEvent } from '#lib/types.js';

/** `<sha16>-<name>` -> `<name>` (see originals.ts). */
function displayName(storedName: string): string {
	return storedName.replace(/^[0-9a-f]{16}-/, '');
}

/** The note's text, or a 404 that does not tell "outside the library" from "missing" (same as /api/library/file). */
function readNote(v: VaultContext, notePath: string): string {
	try {
		return readLibraryFile(v, notePath);
	} catch {
		fail('NOT_FOUND', { entity: 'file' }, 404);
	}
}

/** The kept original for a note's raw text, or null (no source_sha256 / nothing kept for it). */
function findOriginal(v: VaultContext, raw: string): string | null {
	let sha: unknown;
	try {
		sha = matter(raw).data.source_sha256;
	} catch {
		return null;
	}
	return typeof sha === 'string' && sha ? originalPathForSourceSha(v, sha) : null;
}

/** Notes being re-converted right now (vault + path): a double click must not start a second conversion. */
const running = new Set<string>();

/** Can this note be re-imported? Only a lookup — nothing is converted or written. */
export const GET: RequestHandler = async ({ url }) => {
	const v = vaultFromUrl(url);
	const notePath = url.searchParams.get('path');
	if (!notePath) fail('VALIDATION_REQUIRED', { field: 'path' });
	const original = findOriginal(v, readNote(v, notePath));
	return json(original ? { available: true, originalName: displayName(path.basename(original)) } : { available: false });
};

/** Converts the note's kept original again and streams the fresh note text as a `ready` event.
 * Never writes the note, the index or the import log: the editor holds the result as an unsaved
 * draft, and saving goes through the normal PUT /api/library/file (revision + reindex). */
export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json().catch(() => ({}))) as { path?: string; vault?: string };
	if (!body.path || typeof body.path !== 'string') fail('VALIDATION_REQUIRED', { field: 'path' });
	const v = vaultFromId(body.vault);
	const notePath = body.path;
	const oldRaw = readNote(v, notePath);

	const original = findOriginal(v, oldRaw);
	if (!original) fail('REIMPORT_NO_ORIGINAL', undefined, 404);
	const name = safeBasename(displayName(path.basename(original)));
	const ext = path.extname(name).toLowerCase();
	if (!ALLOWED_EXTENSIONS.has(ext) && !CODE_EXTENSIONS.has(ext)) fail('UNSUPPORTED_FILE_TYPE', { ext: ext || '?' });

	const lockKey = `${v.id}\0${notePath}`;
	if (running.has(lockKey)) fail('REIMPORT_BUSY', undefined, 409);
	running.add(lockKey);

	const workDir = path.join(stagingDir(v), crypto.randomUUID());
	return sseStream<ReimportEvent>(async (send) => {
		try {
			fs.mkdirSync(workDir, { recursive: true });
			// A copy: the kept original itself is never moved or touched.
			const tempIn = path.join(workDir, `original${ext}`);
			fs.copyFileSync(original, tempIn);

			send({ type: 'progress', stage: 'queued' });
			const result = await enqueueConversion(
				tempIn,
				workDir,
				'auto',
				(event) => {
					if (event.type === 'progress') {
						send({ type: 'progress', stage: event.stage, pageCount: event.pageCount, estimatedSeconds: event.estimatedSeconds });
					}
				},
				name,
				undefined,
				{ ocrLang: ocrLangArg(undefined, getLibrarySettings(v).allowedLanguages), skipAvScan: true }
			);
			if (!result.outPath) throw new AppError('CONVERSION_EMPTY');

			// Images go into the vault's shared attachments (content-addressed, so re-copying is a no-op);
			// links are made relative to the NOTE's own folder, not staging.
			const converted = importConvertedImages(v, result, notePath, fs.readFileSync(result.outPath, 'utf-8'));
			send({ type: 'ready', content: buildReimportedNote(oldRaw, converted), warnings: [...(result.warnings ?? [])] });
		} catch (err) {
			send({ type: 'error', ...errorPayload(err) });
		} finally {
			fs.rmSync(workDir, { recursive: true, force: true });
			running.delete(lockKey);
		}
	}, (message) => logAppEvent({ kind: 'fatal_error', message: `reimport stream: ${message}` }));
};
