import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import matter from 'gray-matter';
import type { RequestHandler } from './$types';
import { enqueueConversion } from '$lib/server/convertQueue';
import { stagingDir, resolveLibraryPath, slugify, appendImportLog } from '$lib/server/library';
import { indexLibraryFile } from '$lib/server/incrementalIndex';
import { vaultFromId } from '$lib/server/requestVault';
import type { ImportEvent, ImportResultItem, ImportSummary } from '$lib/types';

function sseEvent(event: ImportEvent): string {
	return `data: ${JSON.stringify(event)}\n\n`;
}

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

	const stream = new ReadableStream({
		async start(controller) {
			const encoder = new TextEncoder();
			const send = (event: ImportEvent) => controller.enqueue(encoder.encode(sseEvent(event)));
			const items: ImportResultItem[] = [];

			for (const file of files) {
				send({ type: 'progress', stage: 'converting', fileName: file.name });
				const workDir = path.join(stagingDir(v), crypto.randomUUID());
				fs.mkdirSync(workDir, { recursive: true });
				const ext = path.extname(file.name) || '.bin';
				const tempIn = path.join(workDir, `original${ext}`);
				fs.writeFileSync(tempIn, Buffer.from(await file.arrayBuffer()));

				try {
					const result = await enqueueConversion(tempIn, workDir, 'auto');
					if (!result.outPath) throw new Error('Dönüştürme çıktı üretmedi');

					const raw = fs.readFileSync(result.outPath, 'utf-8');
					const parsed = matter(raw);
					const title = (parsed.data.title as string) ?? path.parse(file.name).name;
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
						importedAt: new Date().toISOString(),
						status: needsReview ? 'needs_review' : 'converted',
						tool: frontmatter.converted_by ?? 'upload-batch'
					});

					const item: ImportResultItem = {
						fileName: file.name,
						status: needsReview ? 'needs_review' : 'converted',
						path: relPath
					};
					items.push(item);
					send({ type: 'item', item });
				} catch (err) {
					const item: ImportResultItem = {
						fileName: file.name,
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
			controller.close();
		}
	});

	return new Response(stream, {
		headers: {
			'content-type': 'text/event-stream',
			'cache-control': 'no-cache',
			connection: 'keep-alive'
		}
	});
};
