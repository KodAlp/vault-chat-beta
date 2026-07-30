import type { RequestHandler } from './$types';
import { generateCards } from '$lib/server/generate-cards';
import { vaultFromId } from '$lib/server/requestVault';
import type { CardGenerationEvent, CardGenerationRequest } from '$lib/types';

function sseEvent(event: CardGenerationEvent): string {
	return `data: ${JSON.stringify(event)}\n\n`;
}

export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json()) as CardGenerationRequest;
	const v = vaultFromId(body.vault);

	const stream = new ReadableStream({
		async start(controller) {
			const encoder = new TextEncoder();
			const send = (event: CardGenerationEvent) =>
				controller.enqueue(encoder.encode(sseEvent(event)));

			try {
				const { deckId } = await generateCards(
					v,
					{
						domains: body.domains,
						chatId: body.chatId,
						prompt: body.prompt,
						count: body.count,
						model: body.model
					},
					(stage) => send({ type: 'progress', stage })
				);
				send({ type: 'done', deckId });
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
