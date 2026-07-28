import type { RequestHandler } from './$types';
import { retrieve } from '$lib/server/retrieve';
import { buildPromptMessages } from '$lib/server/prompt';
import { streamChat } from '$lib/server/ollama';
import type { ChatRequestBody, StreamEvent } from '$lib/types';

function sseEvent(event: StreamEvent): string {
	return `data: ${JSON.stringify(event)}\n\n`;
}

export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json()) as ChatRequestBody;
	const lastUser = body.messages[body.messages.length - 1];

	const stream = new ReadableStream({
		async start(controller) {
			const encoder = new TextEncoder();
			const send = (event: StreamEvent) => controller.enqueue(encoder.encode(sseEvent(event)));

			try {
				const sources = lastUser
					? await retrieve(lastUser.content, { domains: body.domains })
					: [];
				const promptMessages = buildPromptMessages(body.messages, sources);

				for await (const delta of streamChat(body.model, promptMessages)) {
					send({ type: 'delta', content: delta });
				}
				send({ type: 'done', sources });
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
