import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { retrieve } from '$lib/server/retrieve';
import { buildRetrievalQuery } from '$lib/server/retrieval-query';
import { buildPromptMessages } from '$lib/server/prompt';
import { chatWithFallback } from '$lib/server/providers/registry';
import { startFlight, endFlight } from '$lib/server/providers/inflight';
import { ProviderError } from '$lib/server/providers/types';
import { createChat, getChat, insertMessage, updateMessage, touchChat } from '$lib/server/chats-db';
import { generateTitle } from '$lib/server/title';
import { vaultFromId } from '$lib/server/requestVault';
import { logAppEvent } from '$lib/server/app-log';
import { detectHallucinationHedges } from '$lib/server/hallucination';
import { getLibrarySettings } from '$lib/server/library';
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

/** Chat never sent a completion cap, so each provider fell back to its own
 * model default — OpenRouter quoted 64000 tokens and refused the request
 * outright on a low-credit account ("you requested up to 64000 tokens, but
 * can only afford 2666"). This is far above any answer this app actually
 * produces while keeping the request affordable and bounding a runaway
 * generation. The five generators already size their own budgets per request
 * (their *OutputBudget() helpers); this is chat's equivalent. */
const CHAT_MAX_OUTPUT_TOKENS = 4096;

/** qwen3:8b (Ollama, Q4_K_M) occasionally emits an invalid byte sequence
 * that decodes to U+FFFD mid-stream — confirmed model/quantization-level
 * (reproduced via a raw curl straight to Ollama, bypassing this app
 * entirely), not an app encoding bug. A corrupted chunk is never shown to
 * the user; generation is aborted and restarted from scratch (same prompt
 * — the model can't "fix" a decode-time artifact, only re-roll it) up to
 * this many times. Matches generate-quiz.ts's MAX_RETRIES convention. */
const MAX_CORRUPTION_RETRIES = 2;

const CJK_RANGE = /[一-鿿]/; // CJK Unified Ideographs — Chinese hanzi

/** Language names that make CJK Unified Ideographs an EXPECTED script
 * rather than a leak — e.g. a language-learning vault with
 * allowedLanguages ['Türkçe', 'Korece'] must never have its own Korean
 * vocabulary flagged as corruption. Substring-matched, case-insensitive,
 * against LibrarySettings.allowedLanguages — deliberately a plain list,
 * not a rigid enum, so covering another spelling/language is a one-line
 * addition. */
const CJK_LANGUAGE_NAMES = [
	'çince',
	'chinese',
	'mandarin',
	'中文',
	'japonca',
	'japanese',
	'日本語',
	'korece',
	'korean',
	'한국어'
];

function isCjkExpected(allowedLanguages: string[]): boolean {
	return allowedLanguages.some((lang) => {
		const lower = lang.toLowerCase();
		return CJK_LANGUAGE_NAMES.some((name) => lower.includes(name));
	});
}

/** A chunk is treated as corrupted output — never shown to the user,
 * triggers the regenerate-from-scratch loop below — for either of two
 * reasons: a literal U+FFFD (see MAX_CORRUPTION_RETRIES's doc comment), or
 * a CJK character appearing in a vault whose allowedLanguages doesn't
 * expect one (see isCjkExpected). */
function isCorruptedChunk(text: string, allowedLanguages: string[]): boolean {
	return text.includes('�') || (!isCjkExpected(allowedLanguages) && CJK_RANGE.test(text));
}

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
	const allowedLanguages = getLibrarySettings(v).allowedLanguages;
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
			// Set at the bottom of the retry loop, read at the top — lets the
			// attempt>0 reset below pick the right notice wording instead of
			// always claiming corruption, now that an empty-thinking-only
			// answer retries through the same loop (see `emptyAnswer` below).
			let retryReason: 'corrupted' | 'empty' | null = null;
			// True once an empty-answer retry has been exhausted and an `error`
			// event already sent — the loop-terminating `done` below is skipped
			// so the client isn't told this generation succeeded.
			let exhaustedEmpty = false;
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

			// Think-mode only — a non-think chat never produces reasoning text to
			// scan, so this returns [] for it (see hallucination.ts's doc comment).
			function computeHedges(): string[] {
				return body.think && finalThinking ? detectHallucinationHedges(finalThinking) : [];
			}

			function checkpoint() {
				if (!assistantMessageId) return;
				if (finalContent === lastCheckpointedContent && finalThinking === lastCheckpointedThinking) return;
				try {
					updateMessage(assistantMessageId, {
						content: finalContent,
						thinking: finalThinking || null,
						sourcesJson: sources.length ? JSON.stringify(sources) : null,
						hedgesJson: computeHedges().length ? JSON.stringify(computeHedges()) : null
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
				if (isNewChat) createChat(chatId, body.model, v.id, body.provider);
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
					// Not lastUser.content: the query carries the tail of the
					// conversation so a follow-up or an interjection still retrieves
					// against the subject being discussed. See retrieval-query.ts.
					const result = await retrieve(v, buildRetrievalQuery(body.messages), {
						domains: body.domains,
						includedPaths: body.includedPaths,
						// retrieve.ts's own DEFAULT_K (8) is chat's fallback only
						// because no caller ever overrode it — every generator
						// already asks for 12-16. Explaining a whole topic in
						// conversation needs at least as much context as a single
						// quiz question does.
						k: 12
					});
					sources = result.chunks;
					narrowScope = result.narrowScope;
				}
				const promptMessages = await buildPromptMessages(body.messages, sources, allowedLanguages);

				for (let attempt = 0; ; attempt++) {
					if (attempt > 0) {
						// A prior attempt hit U+FFFD or came back empty — throw away
						// whatever it streamed and tell the client to do the same
						// before new deltas arrive.
						finalContent = '';
						finalThinking = '';
						send({ type: 'regenerate' });
						send({
							type: 'notice',
							message:
								retryReason === 'empty'
									? 'Yanıt boş geldi, yeniden üretiliyor…'
									: 'Yanıtta bozuk karakterler algılandı, yeniden üretiliyor…'
						});
					}

					// Per-attempt signal, not `flight.signal` directly — abort() is
					// one-way, so aborting to cancel just this attempt would also
					// permanently kill `flight` and break the next retry. Still
					// cancels immediately if `flight` itself is aborted (client
					// disconnect / superseded by a second message).
					const attemptController = new AbortController();
					const onFlightAbort = () => attemptController.abort();
					if (flight.signal.aborted) attemptController.abort();
					else flight.signal.addEventListener('abort', onFlightAbort);

					let corrupted = false;
					try {
						for await (const event of chatWithFallback(
							'chat',
							{
								model: body.model,
								messages: promptMessages,
								think: body.think ?? false,
								maxOutputTokens: CHAT_MAX_OUTPUT_TOKENS
							},
							attemptController.signal,
							body.provider
						)) {
							if (event.type === 'reasoning') {
								if (isCorruptedChunk(event.text, allowedLanguages)) {
									corrupted = true;
									attemptController.abort();
									break;
								}
								finalThinking += event.text;
								send({ type: 'thinking', content: event.text });
							} else if (event.type === 'text') {
								if (isCorruptedChunk(event.text, allowedLanguages)) {
									corrupted = true;
									attemptController.abort();
									break;
								}
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
					} finally {
						flight.signal.removeEventListener('abort', onFlightAbort);
					}

					// A stream that produced thinking but never any visible text is
					// as unusable as a corrupted one — a real chat persisted exactly
					// this (426 chars of thinking, 0 of answer) and it rendered as a
					// silent blank bubble, indistinguishable from the model having
					// nothing to say. Route it through the same retry-from-scratch
					// loop rather than a second mechanism.
					const emptyAnswer = finalThinking.trim() !== '' && finalContent.trim() === '';
					retryReason = corrupted ? 'corrupted' : emptyAnswer ? 'empty' : null;
					if (!retryReason || flight.signal.aborted) break;
					if (attempt >= MAX_CORRUPTION_RETRIES) {
						if (retryReason === 'corrupted') {
							send({
								type: 'notice',
								message:
									'Yanıt bozuk karakterler içerebilir (bilinen bir model sorunu) — birkaç deneme sonrası temiz üretilemedi.'
							});
							logAppEvent({ kind: 'chat_error', chatId, message: 'U+FFFD corruption persisted after retries' });
						} else {
							// Genuinely empty after every retry — an `error` event, not
							// `done`, and we skip `done` below entirely: sending both
							// left the empty assistant bubble on screen right next to
							// the error text, which is what silently saving it as a
							// blank message looked like from the user's side.
							send({ type: 'error', message: 'Model bir yanıt üretmedi, lütfen tekrar deneyin.' });
							logAppEvent({ kind: 'chat_error', chatId, message: 'empty answer persisted after retries' });
							exhaustedEmpty = true;
						}
						break;
					}
				}
				if (!exhaustedEmpty) {
					const hedges = computeHedges();
					send({ type: 'done', sources, narrowScope, hedges: hedges.length ? hedges : undefined });
				}
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
					// A blank string here is what silently persisted as an empty
					// bubble before this fix — on exhaustedEmpty, save an honest
					// placeholder instead, so a reload shows the same explanation
					// the live `error` event already gave, not an unexplained gap.
					const persistedContent = exhaustedEmpty
						? '_Model bir yanıt üretmedi._'
						: finalContent;
					if (assistantMessageId) {
						// The row already exists from the first-chunk checkpoint
						// above — final write with the complete content, not
						// another insert (which would duplicate the row).
						updateMessage(assistantMessageId, {
							content: persistedContent,
							thinking: finalThinking || null,
							sourcesJson: sources.length ? JSON.stringify(sources) : null,
							hedgesJson: computeHedges().length ? JSON.stringify(computeHedges()) : null
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
							sourcesJson: sources.length ? JSON.stringify(sources) : null,
							hedgesJson: computeHedges().length ? JSON.stringify(computeHedges()) : null
						});
					}
					touchChat(chatId);
					if (isNewChat && lastUser) {
						void generateTitle(
							chatId,
							lastUser.content,
							body.titleModel ?? body.model,
							body.titleProvider ?? body.provider
						);
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
