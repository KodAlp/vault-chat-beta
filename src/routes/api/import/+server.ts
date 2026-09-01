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

/** A browser's <input type=file> always sends a bare filename, but nothing
 * enforces that at the HTTP layer — a hand-crafted multipart request (curl,
 * a script) can set filename="..\\..\\evil.md" and reach the originals copy
 * below (`${importId}-${file.name}`) with a path outside originalsDir(v).
 * basename() once, use the result everywhere file.name would otherwise
 * appear, same fix shape as convert.py's own MARKITDOWN_EXTS gate on the
 * other side of this pipeline. */
function safeBasename(name: string): string {
	// path.basename alone doesn't strip a Windows-style "..\\" prefix on
	// POSIX (no backslash-as-separator there), so both separators are
	// normalized to "/" first.
	return path.basename(name.replace(/\\/g, '/'));
}

/** Same set convert.py actually routes on (MARKITDOWN_EXTS + PDF_EXT +
 * TEX_EXT) plus .md for a source that's already Markdown — anything else is
 * something the converter would only ever fail on or mis-handle, so it's
 * rejected before a subprocess (and its memory/CPU cost) is spent on it. */
const ALLOWED_EXTENSIONS = new Set([
	'.pdf',
	'.docx',
	'.pptx',
	'.xlsx',
	'.html',
	'.htm',
	'.epub',
	'.tex',
	'.md'
]);

/** Generous enough for a large scanned PDF, small enough that one request
 * can't buffer an unbounded upload into memory — see the size check below,
 * which runs BEFORE arrayBuffer() is called, not after. */
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

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
	if (!ALLOWED_EXTENSIONS.has(ext)) {
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

	const importId = crypto.randomUUID();
	const workDir = path.join(stagingDir(v), importId);
	fs.mkdirSync(workDir, { recursive: true });
	const tempIn = path.join(workDir, `original${ext}`);
	fs.writeFileSync(tempIn, Buffer.from(await file.arrayBuffer()));

	const stream = new ReadableStream({
		async start(controller) {
			const encoder = new TextEncoder();
			const send = (event: ImportEvent) => controller.enqueue(encoder.encode(sseEvent(event)));

			try {
				send({ type: 'progress', stage: 'queued' });
				const result = await enqueueConversion(tempIn, workDir, 'auto', (event) => {
					if (event.type === 'progress') send({ type: 'progress', stage: event.stage, fileName: safeName });
				});

				if (!result.outPath) throw new Error('Dönüştürme çıktı üretmedi');

				const stagedMdPath = path.join(stagingDir(v), `${importId}.md`);
				fs.copyFileSync(result.outPath, stagedMdPath);

				if (getLibrarySettings(v).keepOriginals) {
					fs.mkdirSync(originalsDir(v), { recursive: true });
					fs.copyFileSync(tempIn, path.join(originalsDir(v), `${importId}-${safeName}`));
				}
				fs.rmSync(workDir, { recursive: true, force: true });

				const proposedTitle = (result.frontmatter.title as string) ?? path.parse(safeName).name;
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
