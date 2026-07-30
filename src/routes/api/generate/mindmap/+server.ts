import type { RequestHandler } from './$types';
import { generateMindMap } from '$lib/server/generate-mindmap';
import { vaultFromId } from '$lib/server/requestVault';
import type { MindMapGenerationEvent, MindMapGenerationRequest } from '$lib/types';

function sseEvent(event: MindMapGenerationEvent): string {
	return `data: ${JSON.stringify(event)}\n\n`;
}

export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json()) as MindMapGenerationRequest;
	const v = vaultFromId(body.vault);

	const stream = new ReadableStream({
		async start(controller) {
			const encoder = new TextEncoder();
			const send = (event: MindMapGenerationEvent) =>
				controller.enqueue(encoder.encode(sseEvent(event)));

			try {
				const { mindmapId } = await generateMindMap(
					v,
					{
						domains: body.domains,
						chatId: body.chatId,
						prompt: body.prompt,
						model: body.model
					},
					(stage) => send({ type: 'progress', stage })
				);
				send({ type: 'done', mindmapId });
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
