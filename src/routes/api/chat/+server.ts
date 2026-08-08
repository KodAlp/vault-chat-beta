import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { retrieve } from '$lib/server/retrieve';
import { buildPromptMessages } from '$lib/server/prompt';
import { chatWithFallback } from '$lib/server/providers/registry';
import { startFlight, endFlight } from '$lib/server/providers/inflight';
import { ProviderError } from '$lib/server/providers/types';
import { createChat, getChat, insertMessage, updateMessage, touchChat } from '$lib/server/chats-db';
import { generateTitle } from '$lib/server/title';
import { vaultFromId } from '$lib/server/requestVault';
import { logAppEvent } from '$lib/server/app-log';
import type { ChatRequestBody, RetrievedChunk, StreamEvent } from '$lib/types';

function sseEvent(event: StreamEvent): string {
	return `data: ${JSON.stringify(event)}\n\n`;
}

/** How often a still-streaming assistant response gets checkpointed to
 * chats.db (see the lazy insertMessage/updateMessage pair below) — a
 * connection that dies mid-stream (an interrupted navigation, a crash, a
 * network blip) previously lost everything, because the only persist call
 * happened once, in the `finally` block, after the whole stream finished.
 * 2s balances write volume (a cheap single-row UPDATE on an indexed primary
 * key, WAL mode already on) against how much of the freshest content could
 * still be lost in the worst case. */
const CHECKPOINT_INTERVAL_MS = 2000;

/** Auth failures get a clean, actionable message instead of a raw HTTP body
 * — the provider name + "check your key" is what the user can act on. */
function chatErrorMessage(err: unknown): string {
	if (err instanceof ProviderError && err.kind === 'auth') {
		return `${err.providerId}: API anahtarı geçersiz veya eksik`;
	}
	return err instanceof Error ? err.message : 'Bilinmeyen hata';
}

export const POST: RequestHandler = async ({ request }) => {
	let body: ChatRequestBody;
	try {
		body = (await request.json()) as ChatRequestBody;
	} catch {
		error(400, 'Geçersiz istek gövdesi');
	}
	const v = vaultFromId(body.vault);
	const lastUser = body.messages[body.messages.length - 1];
	// The client sends the whole transcript on every turn — trust the shape,
	// not who claims to be the last speaker. Anything else is either a client
	// bug or a forged request, and either way must not silently get logged
	// under the wrong role.
	if (lastUser && lastUser.role !== 'user') {
		error(400, 'Son mesaj kullanıcıdan gelmeli');
	}

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
			let isNewChat = false;
			let sources: RetrievedChunk[] = [];
			let narrowScope = false;
			let finalContent = '';
			let finalThinking = '';
			// Only non-null once startFlight() has actually run — endFlight()
			// in the finally block must not fire for a flight that was never
			// registered (e.g. the DB calls above it threw first).
			let flight: AbortController | null = null;
			let onClientAbort: (() => void) | null = null;

			// Incremental persistence — see CHECKPOINT_INTERVAL_MS's doc comment.
			// assistantMessageId stays null until the first real chunk arrives,
			// preserving the existing "never write an empty assistant row for
			// an early failure" invariant; once set, checkpoint() periodically
			// overwrites that same row instead of inserting new ones.
			let assistantMessageId: string | null = null;
			let lastCheckpointedContent = '';
			let lastCheckpointedThinking = '';
			let checkpointTimer: ReturnType<typeof setInterval> | null = null;

			function checkpoint() {
				if (!assistantMessageId) return;
				if (finalContent === lastCheckpointedContent && finalThinking === lastCheckpointedThinking) return;
				try {
					updateMessage(assistantMessageId, {
						content: finalContent,
						thinking: finalThinking || null,
						sourcesJson: sources.length ? JSON.stringify(sources) : null
					});
					lastCheckpointedContent = finalContent;
					lastCheckpointedThinking = finalThinking;
				} catch {
					// Best-effort — the next tick (or the final save in `finally`)
					// retries with more content anyway; a transient failure here
					// must not interrupt the actual generation.
				}
			}

			try {
				// DB calls live inside this try on purpose — a poisoned chats.db
				// (the exact failure that motivated this rewrite) must surface as
				// a `send({type:'error'})` to the client and an app-log record,
				// not a stream that dies with no explanation.
				isNewChat = !getChat(chatId);
				if (isNewChat) createChat(chatId, body.model, v.id);
				send({ type: 'chatId', chatId });
				if (lastUser) insertMessage({ chatId, role: 'user', content: lastUser.content });

				// Server-side single-flight, independent of this one connection's own
				// abort — a second message for the same chat (a race, a second tab)
				// aborts this flight even if the original client connection never
				// sends its own abort. Merged with the client's own request.signal so
				// either cause stops generation identically.
				flight = startFlight(chatId);
				onClientAbort = () => flight!.abort();
				if (request.signal.aborted) flight.abort();
				else request.signal.addEventListener('abort', onClientAbort);

				if (lastUser) {
					const result = await retrieve(v, lastUser.content, {
						domains: body.domains,
						includedPaths: body.includedPaths
					});
					sources = result.chunks;
					narrowScope = result.narrowScope;
				}
				const promptMessages = await buildPromptMessages(body.messages, sources);

				for await (const event of chatWithFallback(
					'chat',
					{ model: body.model, messages: promptMessages, think: body.think ?? false },
					flight.signal
				)) {
					if (event.type === 'reasoning') {
						finalThinking += event.text;
						send({ type: 'thinking', content: event.text });
					} else if (event.type === 'text') {
						finalContent += event.text;
						send({ type: 'delta', content: event.text });
					} else if (event.type === 'notice') {
						send({ type: 'notice', message: event.message });
						logAppEvent({ kind: 'fallback', chatId, message: event.message });
					}

					if (!assistantMessageId && (finalContent || finalThinking)) {
						// First real content — create the row now instead of waiting
						// for the whole stream to finish, so checkpoint() below (and
						// the final save in `finally`) has something to write into if
						// the connection dies partway through.
						try {
							assistantMessageId = insertMessage({
								chatId,
								role: 'assistant',
								content: finalContent,
								thinking: finalThinking || null,
								sourcesJson: sources.length ? JSON.stringify(sources) : null
							});
							lastCheckpointedContent = finalContent;
							lastCheckpointedThinking = finalThinking;
							checkpointTimer = setInterval(checkpoint, CHECKPOINT_INTERVAL_MS);
						} catch {
							// Best-effort — the finally block's own fallback insert
							// still gets one more try at the end.
						}
					}
				}
				send({ type: 'done', sources, narrowScope });
			} catch (err) {
				// User-initiated stop (interrupt button / navigation) — propagates from
				// the aborted Ollama fetch. Not a real error; say nothing.
				if (!(err instanceof DOMException && err.name === 'AbortError')) {
					const message = chatErrorMessage(err);
					send({ type: 'error', message });
					logAppEvent({ kind: 'chat_error', chatId, message });
				}
			} finally {
				// First — a pending checkpoint firing after this block starts its
				// own final write would be a redundant but harmless race; clearing
				// it up front just avoids that.
				if (checkpointTimer) clearInterval(checkpointTimer);
				if (onClientAbort) request.signal.removeEventListener('abort', onClientAbort);
				if (flight) endFlight(chatId, flight);

				// Own try/catch so a persist failure can't skip controller.close()
				// below (the bug that left streams hanging open on a DB error).
				try {
					if (assistantMessageId) {
						// The row already exists from the first-chunk checkpoint
						// above — final write with the complete content, not
						// another insert (which would duplicate the row).
						updateMessage(assistantMessageId, {
							content: finalContent,
							thinking: finalThinking || null,
							sourcesJson: sources.length ? JSON.stringify(sources) : null
						});
					} else if (finalContent || finalThinking) {
						// Fallback: the lazy insert above never ran (or itself
						// threw) but there's still content worth saving — same
						// "only persist if something was actually produced"
						// invariant as before incremental checkpointing existed.
						insertMessage({
							chatId,
							role: 'assistant',
							content: finalContent,
							thinking: finalThinking || null,
							sourcesJson: sources.length ? JSON.stringify(sources) : null
						});
					}
					touchChat(chatId);
					if (isNewChat && lastUser) {
						void generateTitle(chatId, lastUser.content, body.titleModel ?? body.model);
					}
				} catch (err) {
					const message = err instanceof Error ? err.message : 'Bilinmeyen hata';
					logAppEvent({ kind: 'db_error', chatId, message });
					send({ type: 'error', message: `Sohbet kaydedilemedi: ${message}` });
				}

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
