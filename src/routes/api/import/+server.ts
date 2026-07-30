import fs from 'node:fs';
import path from 'node:path';
import type { RequestHandler } from './$types';
import { enqueueConversion } from '$lib/server/convertQueue';
import { stagingDir, originalsDir, getLibrarySettings } from '$lib/server/library';
import { vaultFromId } from '$lib/server/requestVault';
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
	const v = vaultFromId(formData.get('vault') as string | null);

	const importId = crypto.randomUUID();
	const workDir = path.join(stagingDir(v), importId);
	fs.mkdirSync(workDir, { recursive: true });
	const ext = path.extname(file.name) || '.bin';
	const tempIn = path.join(workDir, `original${ext}`);
	fs.writeFileSync(tempIn, Buffer.from(await file.arrayBuffer()));

	const stream = new ReadableStream({
		async start(controller) {
			const encoder = new TextEncoder();
			const send = (event: ImportEvent) => controller.enqueue(encoder.encode(sseEvent(event)));

			try {
				send({ type: 'progress', stage: 'queued' });
				const result = await enqueueConversion(tempIn, workDir, 'auto', (event) => {
					if (event.type === 'progress') send({ type: 'progress', stage: event.stage, fileName: file.name });
				});

				if (!result.outPath) throw new Error('Dönüştürme çıktı üretmedi');

				const stagedMdPath = path.join(stagingDir(v), `${importId}.md`);
				fs.copyFileSync(result.outPath, stagedMdPath);

				if (getLibrarySettings(v).keepOriginals) {
					fs.mkdirSync(originalsDir(v), { recursive: true });
					fs.copyFileSync(tempIn, path.join(originalsDir(v), `${importId}-${file.name}`));
				}
				fs.rmSync(workDir, { recursive: true, force: true });

				const proposedTitle = (result.frontmatter.title as string) ?? path.parse(file.name).name;
				send({
					type: 'ready',
					importId,
					proposed: { title: proposedTitle, domain: 'genel', level: 'undergraduate' },
					warnings: result.warnings ?? []
				});
			} catch (err) {
				fs.rmSync(workDir, { recursive: true, force: true });
				send({ type: 'error', message: err instanceof Error ? err.message : 'Bilinmeyen hata' });
			} finally {
				controller.close();
			}
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
