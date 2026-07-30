import type { RequestHandler } from './$types';
import { importObsidianVault } from '$lib/server/importObsidian';
import { vaultFromId } from '$lib/server/requestVault';
import type { ObsidianImportEvent } from '$lib/types';

function sseEvent(event: ObsidianImportEvent): string {
	return `data: ${JSON.stringify(event)}\n\n`;
}

export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json()) as { sourcePath: string; vault?: string };
	const v = vaultFromId(body.vault);

	const stream = new ReadableStream({
		async start(controller) {
			const encoder = new TextEncoder();
			const send = (event: ObsidianImportEvent) => controller.enqueue(encoder.encode(sseEvent(event)));

			try {
				send({ type: 'progress', stage: 'scanning' });
				const summary = await importObsidianVault(v, body.sourcePath, (item) => send({ type: 'item', item }));
				send({ type: 'done', summary });
			} catch (err) {
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
