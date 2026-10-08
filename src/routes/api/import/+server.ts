import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { RequestHandler } from './$types';
import { enqueueConversion } from '$lib/server/convertQueue';
import {
	stagingDir,
	safeBasename,
	importLogPath,
	loadImportedSourceHashes,
	ALLOWED_EXTENSIONS,
	CODE_EXTENSIONS,
	MAX_UPLOAD_BYTES
} from '$lib/server/library';
import { keepOriginalCopy } from '$lib/server/originals';
import { vaultFromId } from '$lib/server/requestVault';
import { importConvertedImages, libraryRelPath } from '$lib/server/converted-images';
import { sseStream } from '$lib/server/sse';
import { logAppEvent } from '$lib/server/app-log';
import { AppError, errorPayload } from '$lib/server/app-error';
import type { ImportEvent } from '$lib/types';

function sseEvent(event: ImportEvent): string {
	return `data: ${JSON.stringify(event)}\n\n`;
}

/** Pre-stream validation failure — no sseStream running yet, so this is a
 * one-shot SSE-shaped response carrying a single coded error event,
 * matching the shape every mid-stream error takes (see errorPayload()). */
function sseErrorResponse(err: unknown): Response {
	return new Response(sseEvent({ type: 'error', ...errorPayload(err) }), {
		headers: { 'content-type': 'text/event-stream' }
	});
}

/** Single-file upload with a confirm step — see /api/library/import/[id]/confirm.
 * Converts into a staging file, does NOT touch the library tree/index yet. */
export const POST: RequestHandler = async ({ request }) => {
	const formData = await request.formData();
	const file = formData.get('file');
	if (!(file instanceof File)) {
		return sseErrorResponse(new AppError('VALIDATION_REQUIRED', { field: 'file' }));
	}

	const safeName = safeBasename(file.name);
	const ext = path.extname(safeName).toLowerCase();
	if (!ALLOWED_EXTENSIONS.has(ext) && !CODE_EXTENSIONS.has(ext)) {
		return sseErrorResponse(new AppError('UNSUPPORTED_FILE_TYPE', { ext: ext || '?' }));
	}
	// Checked against file.size (from the Web File API, available without
	// reading the body) before arrayBuffer() ever runs — the whole point is
	// never buffering an oversized upload into memory in the first place.
	if (file.size > MAX_UPLOAD_BYTES) {
		return sseErrorResponse(new AppError('FILE_TOO_LARGE', { limitMb: Math.round(MAX_UPLOAD_BYTES / (1024 * 1024)) }));
	}

	const v = vaultFromId(formData.get('vault') as string | null);

	const fileBytes = Buffer.from(await file.arrayBuffer());
	// E5: content-addressed duplicate check, computed before conversion so it
	// costs nothing beyond a hash even on a hit. A confirm step still exists
	// here (unlike the batch route, which skips outright) — the user might
	// legitimately want a second copy under a different title/domain, so
	// this surfaces as a warning in the confirm dialog rather than blocking.
	const alreadyImportedHash = loadImportedSourceHashes(importLogPath(v)).has(
		crypto.createHash('sha256').update(fileBytes).digest('hex')
	);

	const importId = crypto.randomUUID();
	const workDir = path.join(stagingDir(v), importId);
	fs.mkdirSync(workDir, { recursive: true });
	const tempIn = path.join(workDir, `original${ext}`);
	fs.writeFileSync(tempIn, fileBytes);

	// sseStream, not a bare ReadableStream: send() used to enqueue
	// unconditionally, so a client that gave up mid-conversion (closed tab,
	// navigated away — a real risk here since a large PDF can take minutes)
	// left the NEXT enqueue call (from enqueueConversion's own progress
	// callback) throwing into an uncaughtException with no catcher, which
	// took the whole server down. See sse.ts's doc comment — this is the
	// same fix already applied to the five /api/generate/* routes.
	return sseStream<ImportEvent>(async (send) => {
		try {
			send({ type: 'progress', stage: 'queued' });
			const result = await enqueueConversion(
				tempIn,
				workDir,
				'auto',
				(event) => {
					if (event.type === 'progress') {
						send({
							type: 'progress',
							stage: event.stage,
							fileName: safeName,
							pageCount: event.pageCount,
							estimatedSeconds: event.estimatedSeconds
						});
					}
				},
				safeName
			);

			if (!result.outPath) throw new AppError('CONVERSION_EMPTY');

			const stagedMdPath = path.join(stagingDir(v), `${importId}.md`);
			// Images are copied into the vault before workDir is removed below.
			fs.writeFileSync(
				stagedMdPath,
				importConvertedImages(v, result, libraryRelPath(v, stagedMdPath), fs.readFileSync(result.outPath, 'utf-8')),
				'utf-8'
			);

			// Content-addressed (<sha16>-<name>) so the note can be linked back to its original by source_sha256.
			await keepOriginalCopy(v, tempIn, safeName, crypto.createHash('sha256').update(fileBytes).digest('hex'));
			fs.rmSync(workDir, { recursive: true, force: true });

			const proposedTitle = (result.frontmatter.title as string) ?? path.parse(safeName).name;
			const warnings = [...(result.warnings ?? [])];
			if (alreadyImportedHash) {
				warnings.push('IMPORT_DUPLICATE_CONTENT');
			}
			send({
				type: 'ready',
				importId,
				proposed: { title: proposedTitle, domain: 'genel', level: 'undergraduate' },
				warnings
			});
		} catch (err) {
			fs.rmSync(workDir, { recursive: true, force: true });
			send({ type: 'error', ...errorPayload(err) });
		}
	}, (message) => logAppEvent({ kind: 'fatal_error', message: `import stream: ${message}` }));
};
