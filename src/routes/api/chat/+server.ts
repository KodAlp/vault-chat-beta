import type { RequestHandler } from './$types';
import { retrieve } from '$lib/server/retrieve';
import { buildPromptMessages } from '$lib/server/prompt';
import { streamChat } from '$lib/server/ollama';
import { createChat, getChat, insertMessage, touchChat } from '$lib/server/chats-db';
import { generateTitle } from '$lib/server/title';
import type { ChatRequestBody, RetrievedChunk, StreamEvent } from '$lib/types';

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

			// Client generates the id (welcome screen navigates to /chat/{id} before
			// the first message is even sent) — this route just upserts it.
			const chatId = body.chatId ?? crypto.randomUUID();
			const isNewChat = !getChat(chatId);
			if (isNewChat) createChat(chatId, body.model);
			send({ type: 'chatId', chatId });
			if (lastUser) insertMessage({ chatId, role: 'user', content: lastUser.content });

			let sources: RetrievedChunk[] = [];
			let finalContent = '';
			let finalThinking = '';

			try {
				sources = lastUser ? await retrieve(lastUser.content, { domains: body.domains }) : [];
				const promptMessages = buildPromptMessages(body.messages, sources);

				for await (const piece of streamChat(
					body.model,
					promptMessages,
					body.think ?? false,
					request.signal
				)) {
					if (piece.kind === 'thinking') {
						finalThinking += piece.text;
						send({ type: 'thinking', content: piece.text });
					} else {
						finalContent += piece.text;
						send({ type: 'delta', content: piece.text });
					}
				}
				send({ type: 'done', sources });
			} catch (err) {
				// User-initiated stop (interrupt button / navigation) — propagates from
				// the aborted Ollama fetch. Not a real error; say nothing.
				if (!(err instanceof DOMException && err.name === 'AbortError')) {
					send({ type: 'error', message: err instanceof Error ? err.message : 'Bilinmeyen hata' });
				}
			} finally {
				// Persist whatever the assistant produced, even if stopped partway
				// through — matches what stays visible on screen (see "Durduruldu").
				insertMessage({
					chatId,
					role: 'assistant',
					content: finalContent,
					thinking: finalThinking || null,
					sourcesJson: sources.length ? JSON.stringify(sources) : null
				});
				touchChat(chatId);
				if (isNewChat && lastUser) void generateTitle(chatId, lastUser.content, body.titleModel);

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
