import fs from 'node:fs';
import path from 'node:path';
import type { RequestHandler } from './$types';
import { enqueueYoutubeTranscript } from '$lib/server/youtubeQueue';
import { stagingDir } from '$lib/server/library';
import { vaultFromId } from '$lib/server/requestVault';
import { sseStream } from '$lib/server/sse';
import { logAppEvent } from '$lib/server/app-log';
import type { ImportEvent } from '$lib/types';

const YOUTUBE_URL = /^https?:\/\/(www\.)?(youtube\.com\/(watch\?|shorts\/)|youtu\.be\/)/i;

function sseEvent(event: ImportEvent): string {
	return `data: ${JSON.stringify(event)}\n\n`;
}

/** URL-input twin of POST /api/import — see /api/library/import/[id]/confirm
 * for the shared review/save step. No "keep original file" concept here
 * (there's no original file, just a URL), unlike the file-upload path. */
export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json().catch(() => null)) as { url?: string; vault?: string } | null;
	const url = body?.url?.trim();
	if (!url || !YOUTUBE_URL.test(url)) {
		return new Response(sseEvent({ type: 'error', message: 'Geçerli bir YouTube bağlantısı gerekli' }), {
			headers: { 'content-type': 'text/event-stream' }
		});
	}
	const v = vaultFromId(body?.vault ?? null);

	const importId = crypto.randomUUID();
	const workDir = path.join(stagingDir(v), importId);
	fs.mkdirSync(workDir, { recursive: true });

	// sseStream, not a bare ReadableStream — same crash this fixed for the
	// five /api/generate/* routes and for /api/import: a transcript fetch can
	// run long enough for the client to give up before it finishes, and the
	// next send() after that used to throw uncaught and take the server down.
	return sseStream<ImportEvent>(async (send) => {
		try {
			const result = await enqueueYoutubeTranscript(url, workDir, (event) => {
				if (event.type === 'progress') send({ type: 'progress', stage: event.stage });
			});

			if (!result.outPath) throw new Error('Transkript çıktı üretmedi');

			const stagedMdPath = path.join(stagingDir(v), `${importId}.md`);
			fs.copyFileSync(result.outPath, stagedMdPath);
			fs.rmSync(workDir, { recursive: true, force: true });

			const proposedTitle = (result.frontmatter.title as string) ?? 'YouTube video';
			send({
				type: 'ready',
				importId,
				proposed: { title: proposedTitle, domain: 'genel', level: 'undergraduate' },
				warnings: result.warnings ?? []
			});
		} catch (err) {
			fs.rmSync(workDir, { recursive: true, force: true });
			send({ type: 'error', message: err instanceof Error ? err.message : 'Bilinmeyen hata' });
		}
	}, (message) => logAppEvent({ kind: 'fatal_error', message: `youtube import stream: ${message}` }));
};
