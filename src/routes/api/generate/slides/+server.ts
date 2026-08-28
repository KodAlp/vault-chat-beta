import type { RequestHandler } from './$types';
import { generateSlides } from '$lib/server/generate-slides';
import { vaultFromId } from '$lib/server/requestVault';
import { NoSourcesError } from '$lib/server/generate-errors';
import type { SlidesGenerationEvent, SlidesGenerationRequest } from '$lib/types';

function sseEvent(event: SlidesGenerationEvent): string {
	return `data: ${JSON.stringify(event)}\n\n`;
}

export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json()) as SlidesGenerationRequest;
	const v = vaultFromId(body.vault);

	const stream = new ReadableStream({
		async start(controller) {
			const encoder = new TextEncoder();
			const send = (event: SlidesGenerationEvent) =>
				controller.enqueue(encoder.encode(sseEvent(event)));

			try {
				const { slideDeckId } = await generateSlides(
					v,
					{
						domains: body.domains,
						chatId: body.chatId,
						prompt: body.prompt,
						model: body.model,
						includedPaths: body.includedPaths
					},
					(stage, elapsedMs) => send({ type: 'progress', stage, elapsedMs })
				);
				send({ type: 'done', slideDeckId });
			} catch (err) {
				send({
					type: 'error',
					message: err instanceof Error ? err.message : 'Bilinmeyen hata',
					narrowScope: err instanceof NoSourcesError ? err.narrowScope : undefined
				});
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
