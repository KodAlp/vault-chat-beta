import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { RequestHandler } from './$types';
import { enqueueConversion } from '$lib/server/convertQueue';
import {
	stagingDir,
	originalsDir,
	getLibrarySettings,
	safeBasename,
	importLogPath,
	loadImportedSourceHashes,
	ALLOWED_EXTENSIONS,
	CODE_EXTENSIONS,
	MAX_UPLOAD_BYTES
} from '$lib/server/library';
import { vaultFromId } from '$lib/server/requestVault';
import { sseStream } from '$lib/server/sse';
import { logAppEvent } from '$lib/server/app-log';
import type { ImportEvent } from '$lib/types';

function sseEvent(event: ImportEvent): string {
	return `data: ${JSON.stringify(event)}\n\n`;
}

/** Single-file upload with a confirm step — see /api/library/import/[id]/confirm.
 * Converts into a staging file, does NOT touch the library tree/index yet. */
export const POST: RequestHandler = async ({ request }) => {
	const formData = await request.formData();
	const file = formData.get('file');
	if (!(file instanceof File)) {
		return new Response(sseEvent({ type: 'error', message: 'Dosya gerekli' }), {
			headers: { 'content-type': 'text/event-stream' }
		});
	}

	const safeName = safeBasename(file.name);
	const ext = path.extname(safeName).toLowerCase();
	if (!ALLOWED_EXTENSIONS.has(ext) && !CODE_EXTENSIONS.has(ext)) {
		return new Response(sseEvent({ type: 'error', message: `Desteklenmeyen dosya türü: ${ext || '(uzantısız)'}` }), {
			headers: { 'content-type': 'text/event-stream' }
		});
	}
	// Checked against file.size (from the Web File API, available without
	// reading the body) before arrayBuffer() ever runs — the whole point is
	// never buffering an oversized upload into memory in the first place.
	if (file.size > MAX_UPLOAD_BYTES) {
		return new Response(sseEvent({ type: 'error', message: 'Dosya çok büyük (100MB sınırı)' }), {
			headers: { 'content-type': 'text/event-stream' }
		});
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

			if (!result.outPath) throw new Error('Dönüştürme çıktı üretmedi');

			const stagedMdPath = path.join(stagingDir(v), `${importId}.md`);
			fs.copyFileSync(result.outPath, stagedMdPath);

			if (getLibrarySettings(v).keepOriginals) {
				fs.mkdirSync(originalsDir(v), { recursive: true });
				fs.copyFileSync(tempIn, path.join(originalsDir(v), `${importId}-${safeName}`));
			}
			fs.rmSync(workDir, { recursive: true, force: true });

			const proposedTitle = (result.frontmatter.title as string) ?? path.parse(safeName).name;
			const warnings = [...(result.warnings ?? [])];
			if (alreadyImportedHash) {
				warnings.push('Bu dosya (aynı içerik) daha önce içe aktarılmış görünüyor — yine de devam edebilirsin.');
			}
			send({
				type: 'ready',
				importId,
				proposed: { title: proposedTitle, domain: 'genel', level: 'undergraduate' },
				warnings
			});
		} catch (err) {
			fs.rmSync(workDir, { recursive: true, force: true });
			send({ type: 'error', message: err instanceof Error ? err.message : 'Bilinmeyen hata' });
		}
	}, (message) => logAppEvent({ kind: 'fatal_error', message: `import stream: ${message}` }));
};
