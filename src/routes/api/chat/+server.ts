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
			let closed = false;
			const send = (event: StreamEvent) => {
				if (closed) return;
				try {
					controller.enqueue(encoder.encode(sseEvent(event)));
				} catch {
					// controller already errored/closed (client disconnected mid-enqueue)
				}
			};

			try {
				const sources = lastUser
					? await retrieve(lastUser.content, { domains: body.domains })
					: [];
				const promptMessages = buildPromptMessages(body.messages, sources);

				for await (const piece of streamChat(
					body.model,
					promptMessages,
					body.think ?? false,
					request.signal
				)) {
					send(
						piece.kind === 'thinking'
							? { type: 'thinking', content: piece.text }
							: { type: 'delta', content: piece.text }
					);
				}
				send({ type: 'done', sources });
			} catch (err) {
				// User-initiated stop (interrupt button / navigation) — propagates from
				// the aborted Ollama fetch. Not a real error; say nothing.
				if (!(err instanceof DOMException && err.name === 'AbortError')) {
					send({ type: 'error', message: err instanceof Error ? err.message : 'Bilinmeyen hata' });
				}
			} finally {
				closed = true;
				try {
					controller.close();
				} catch {
					// already closed/errored by the runtime when the client disconnected
				}
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
