import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import matter from 'gray-matter';
import type { RequestHandler } from './$types';
import { enqueueConversion } from '$lib/server/convertQueue';
import {
	stagingDir,
	resolveLibraryPath,
	slugify,
	appendImportLog,
	importLogPath,
	loadImportedSourceHashes,
	safeBasename,
	ALLOWED_EXTENSIONS,
	MAX_UPLOAD_BYTES
} from '$lib/server/library';
import { indexLibraryFile } from '$lib/server/incrementalIndex';
import { vaultFromId } from '$lib/server/requestVault';
import { sseStream } from '$lib/server/sse';
import { logAppEvent } from '$lib/server/app-log';
import type { ImportEvent, ImportResultItem, ImportSummary } from '$lib/types';

/**
 * Batch upload — no per-file confirm step (would be tedious for N files):
 * defaults are auto-applied (title = converter's H1/filename guess, domain =
 * the folder the user dropped into, level = undergraduate), needs_review
 * carried through from the converter, and the whole thing ends in a
 * pdf2md-style summary. Single-file upload (/api/import) keeps the nicer
 * confirm-dialog flow — see the Faz 5 plan for why the two differ.
 */
export const POST: RequestHandler = async ({ request }) => {
	const formData = await request.formData();
	const domain = (formData.get('domain') as string | null)?.trim() || 'genel';
	const files = formData.getAll('files').filter((f): f is File => f instanceof File);
	const v = vaultFromId(formData.get('vault') as string | null);

	// sseStream, not a bare ReadableStream — same crash this fixed for the
	// five /api/generate/* routes and for /api/import: an abandoned batch
	// upload (a real risk when it's converting several files back to back)
	// used to throw an unhandled error out of the next send() and take the
	// whole server down instead of just this one request.
	return sseStream<ImportEvent>(async (send) => {
		const items: ImportResultItem[] = [];
		// E5: content-addressed, not just "have we seen this exact URL/name
		// before" — catches the same PDF re-dropped under a different
		// filename, which a name-only check never would.
		const alreadyImported = loadImportedSourceHashes(importLogPath(v));

		for (const file of files) {
			const safeName = safeBasename(file.name);
			send({ type: 'progress', stage: 'converting', fileName: safeName });

			const ext = path.extname(safeName).toLowerCase() || '.bin';
			if (!ALLOWED_EXTENSIONS.has(ext)) {
				const item: ImportResultItem = {
					fileName: safeName,
					status: 'failed',
					reason: `Desteklenmeyen dosya türü: ${ext || '(uzantısız)'}`
				};
				items.push(item);
				send({ type: 'item', item });
				continue;
			}
			if (file.size > MAX_UPLOAD_BYTES) {
				const item: ImportResultItem = {
					fileName: safeName,
					status: 'failed',
					reason: 'Dosya çok büyük (100MB sınırı)'
				};
				items.push(item);
				send({ type: 'item', item });
				continue;
			}

			const fileBytes = Buffer.from(await file.arrayBuffer());
			const sourceSha256 = crypto.createHash('sha256').update(fileBytes).digest('hex');
			if (alreadyImported.has(sourceSha256)) {
				const item: ImportResultItem = { fileName: safeName, status: 'skipped' };
				items.push(item);
				send({ type: 'item', item });
				continue;
			}

			const workDir = path.join(stagingDir(v), crypto.randomUUID());
			fs.mkdirSync(workDir, { recursive: true });
			const tempIn = path.join(workDir, `original${ext}`);
			fs.writeFileSync(tempIn, fileBytes);

			try {
				const result = await enqueueConversion(tempIn, workDir, 'auto', undefined, safeName);
				if (!result.outPath) throw new Error('Dönüştürme çıktı üretmedi');

				const raw = fs.readFileSync(result.outPath, 'utf-8');
				const parsed = matter(raw);
				const title = (parsed.data.title as string) ?? path.parse(safeName).name;
				const needsReview = parsed.data.needs_review === true;
				const frontmatter: Record<string, unknown> = {
					...parsed.data,
					title,
					domain,
					level: 'undergraduate'
				};

				const filename = `${slugify(v, title, domain)}.md`;
				const relPath = `${domain}/${filename}`;
				const destAbs = resolveLibraryPath(v, relPath);
				fs.mkdirSync(path.dirname(destAbs), { recursive: true });
				const finalRaw = matter.stringify(parsed.content, frontmatter);
				fs.writeFileSync(destAbs, finalRaw, 'utf-8');
				await indexLibraryFile(v, destAbs, relPath);

				appendImportLog(v, {
					sourcePath: relPath,
					sha256: crypto.createHash('sha256').update(finalRaw).digest('hex'),
					sourceSha256: frontmatter.source_sha256 ?? sourceSha256,
					importedAt: new Date().toISOString(),
					status: needsReview ? 'needs_review' : 'converted',
					tool: frontmatter.converted_by ?? 'upload-batch'
				});

				const item: ImportResultItem = {
					fileName: safeName,
					status: needsReview ? 'needs_review' : 'converted',
					path: relPath
				};
				items.push(item);
				send({ type: 'item', item });
			} catch (err) {
				const item: ImportResultItem = {
					fileName: safeName,
					status: 'failed',
					reason: err instanceof Error ? err.message : 'Bilinmeyen hata'
				};
				items.push(item);
				send({ type: 'item', item });
			} finally {
				fs.rmSync(workDir, { recursive: true, force: true });
			}
		}

		const summary: ImportSummary = { items };
		send({ type: 'done', summary });
	}, (message) => logAppEvent({ kind: 'fatal_error', message: `batch import stream: ${message}` }));
};
