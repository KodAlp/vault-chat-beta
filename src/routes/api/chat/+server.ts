import type { RequestHandler } from './$types';
import { fail, errorPayload } from '$lib/server/app-error';
import type { ErrorCode, ErrorParams } from '$lib/errors';
import { retrieve } from '$lib/server/retrieve';
import { buildRetrievalQuery } from '$lib/server/retrieval-query';
import { buildPromptMessages } from '$lib/server/prompt';
import { chatWithFallback, modelCaps, servedContext, supportsPrefixResume } from '$lib/server/providers/registry';
import { startFlight, endFlight } from '$lib/server/providers/inflight';
import type { ChatMessage as ProviderChatMessage } from '$lib/server/providers/types';
import { readProvidersFile } from '$lib/server/providers/config-store';
import { unreachableLocalServerLabel } from '$lib/server/providers/local-unreachable';
import {
	canRetryResume,
	createSeamTrimmer,
	findCorruption,
	planRecovery,
	RESUME_STOP,
	type CorruptionKind,
	type SeamPlan,
	type SeamTrimmer
} from '$lib/server/resume-plan';
import { isNearCtxLimit } from '$lib/server/providers/ollama-usage';
import { chatRetrievalK } from '$lib/server/env';
import { afterSmallTalkGate, checkSmallTalk } from '$lib/server/smalltalk-runtime';
import { createChat, getChat, insertMessage, updateMessage, touchChat } from '$lib/server/chats-db';
import { generateTitle } from '$lib/server/title';
import { vaultFromId } from '$lib/server/requestVault';
import { logAppEvent } from '$lib/server/app-log';
import { detectHallucinationHedges, mergeHedgeMatches } from '$lib/server/hallucination';
import { getLibrarySettings } from '$lib/server/library';
import { hasFetchableFolderSkills } from '$lib/server/userSkills';
import { READ_SKILL_FILE_TOOL, executeReadSkillFile } from '$lib/server/skillTool';
import { decideResponseLanguage } from '$lib/server/response-language';
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

/* How many chunks chat retrieves comes from env.ts's chatRetrievalK()
 * (CHAT_RETRIEVAL_K, default 6). 12 chunks of up to 2048 chars is ~6k tokens
 * of <context> alone, which does not fit qwen3's 8192 serveCtx once the system
 * prompt and history are added — Ollama then truncates from the FRONT, where
 * the system rules live (providers/ollama.ts, MODEL_FAMILY_TABLE has the
 * measurements). Measured on a real 6 GB GPU, prompt length also roughly halves
 * decode speed (3.6 tok/s at an 8.4k prompt vs 7.2 at 2.8k, same 16384 window).
 * Chat only: the generators are one-shot calls that gain from breadth and are
 * not latency-sensitive, so they keep their own k.
 *
 * A quality/latency trade — whether 6 answers as well as 12 is a judgment the
 * timing logs cannot make. A machine with more VRAM should raise it together
 * with OLLAMA_SERVE_CTX (README, "Küçük GPU'lar için performans ayarları"). */

/** qwen3:8b (Ollama, Q4_K_M) occasionally emits an invalid byte sequence
 * that decodes to U+FFFD mid-stream — confirmed model/quantization-level
 * (reproduced via a raw curl straight to Ollama, bypassing this app
 * entirely), not an app encoding bug. A corrupted chunk is never shown to
 * the user; generation is aborted and restarted from scratch (same prompt
 * — the model can't "fix" a decode-time artifact, only re-roll it) up to
 * this many times. Matches generate-quiz.ts's MAX_RETRIES convention. */
const MAX_CORRUPTION_RETRIES = 2;

/** Caps how many times, within one attempt, the model can call
 * read_skill_file before being forced to answer in plain text (the final
 * hop simply omits `tools` from the request once this is hit) — a
 * hallucinating or looping model must not turn one chat turn into an
 * unbounded chain of server round-trips. See userSkills.ts/skillTool.ts for
 * what the tool actually does; this route only orchestrates the hops. */
const MAX_TOOL_ROUNDTRIPS = 4;

/** Every coded chat notice/error this route sends is built through one of
 * these two — `message` is set to the code itself (errorPayload's own
 * convention) purely as a legible fallback for a client that only reads
 * `.message`; the real client path renders via `code`/`params` (see
 * server-error.ts's localizeError). */
function noticeEvent(code: ErrorCode, params?: ErrorParams): StreamEvent {
	return { type: 'notice', message: code, code, params };
}
function errorEvent(code: ErrorCode, params?: ErrorParams): StreamEvent {
	return { type: 'error', message: code, code, params };
}

export const POST: RequestHandler = async ({ request }) => {
	let body: ChatRequestBody;
	try {
		body = (await request.json()) as ChatRequestBody;
	} catch {
		fail('CHAT_INVALID_BODY', undefined, 400);
	}
	const v = vaultFromId(body.vault);
	const librarySettings = getLibrarySettings(v);
	const allowedLanguages = librarySettings.allowedLanguages;
	const responseLanguage = librarySettings.responseLanguage;
	const lastUser = body.messages[body.messages.length - 1];
	// The client sends the whole transcript on every turn — trust the shape,
	// not who claims to be the last speaker. Anything else is either a client
	// bug or a forged request, and either way must not silently get logged
	// under the wrong role.
	if (lastUser && lastUser.role !== 'user') {
		fail('CHAT_LAST_MESSAGE_NOT_USER', undefined, 400);
	}
	// 'match' mode: the leak/corruption detector (findCorruption, resume-plan.ts) must not flag a
	// CJK answer as corrupted when THIS turn's own detected language is CJK, even if the vault's
	// configured allowedLanguages never mentions one — buildPromptMessages() computes the same
	// decision internally to build the directive line (see prompt.ts), this is a second, cheap
	// (pure, no model call) computation just to extend the corruption detector's expected-language
	// list. 'fixed' mode never appends a directive, so the detector keeps using allowedLanguages as-is.
	const languagesForCorruptionCheck =
		responseLanguage === 'match' && lastUser
			? [
					...allowedLanguages,
					decideResponseLanguage(
						lastUser.content,
						body.messages
							.slice(0, -1)
							.filter((m) => m.role === 'user')
							.map((m) => m.content),
						allowedLanguages.length ? allowedLanguages[0] : 'Türkçe'
					).englishName
				]
			: allowedLanguages;

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
			let smallTalk = false;
			// Asama 3a - mirrors RetrieveResult.embeddingIssue for this turns
			// retrieval; sources may still be non-empty (the FTS keyword
			// fallback) even when this is set, unlike the five generators, which
			// refuse instead (see generate-errors.ts assertNoEmbeddingIssue).
			let embeddingIssue: 'mismatch' | 'unavailable' | undefined;
			let finalContent = '';
			let finalThinking = '';
			// F8 — true once any model call this turn (across retries/tool-hops) came close to the context
			// window; surfaced to the client so "the answer may be missing earlier context" is visible, not
			// only logged. Ephemeral like narrowScope/smallTalk, not persisted (see Message.svelte).
			let nearCtxLimit = false;
			// Set at the bottom of the retry loop, read at the top — lets the
			// attempt>0 reset below pick the right notice wording instead of
			// always claiming corruption, now that an empty-thinking-only
			// answer retries through the same loop (see `emptyAnswer` below).
			let retryReason: 'corrupted' | 'empty' | null = null;
			// True once an empty-answer retry has been exhausted and an `error`
			// event already sent — the loop-terminating `done` below is skipped
			// so the client isn't told this generation succeeded.
			let exhaustedEmpty = false;
			// Set once an `error` event reached the client: the finalizer's own save failure (the
			// same broken chats.db, again) is then only logged, not sent as a second error.
			let errorSent = false;
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

			// Scans both the reasoning trace (when there is one — think-mode only) and the final
			// answer text (always), merged — see hallucination.ts's doc comment.
			function computeHedges(): string[] {
				const fromThinking = finalThinking ? detectHallucinationHedges(finalThinking) : [];
				const fromAnswer = finalContent ? detectHallucinationHedges(finalContent) : [];
				return mergeHedgeMatches(fromThinking, fromAnswer);
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
				if (isNewChat) createChat(chatId, body.model, v.id, body.provider, body.mode);
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
						k: chatRetrievalK(),
						keywordFallback: true,
						// The newest message alone, not the multi-turn vector query: see retrieve.ts.
						keywordQuery: lastUser.content,
						// Greetings/slang/tests get no sources (smalltalk-gate.ts); "Yine de kaynak ara" bypasses it.
						smallTalkGate: checkSmallTalk,
						forceSources: body.forceSources === true
					});
					sources = result.chunks;
					narrowScope = result.narrowScope;
					smallTalk = result.smallTalk === true;
					// 'fts-only' is the expected, configured state (no embedding provider) — not a client warning.
					embeddingIssue = result.embeddingIssue === 'fts-only' ? undefined : result.embeddingIssue;
					logAppEvent({
						kind: 'retrieval',
						chatId,
						message: sources.length ? `${sources.length} kaynak${result.keyword ? ' (anahtar kelime yedeği)' : ''}` : `kaynak yok (${result.reason ?? '?'})`,
						chunks: sources.length,
						reason: result.reason,
						bestDistance: result.bestDistance === undefined ? undefined : Math.round(result.bestDistance * 1000) / 1000,
						keyword: result.keyword ?? false,
						...(result.gate
							? {
									smallTalk,
									gateSim: Math.round(result.gate.sim * 1000) / 1000,
									gateVia: result.gate.via,
									gatePhraseId: result.gate.phraseId,
									gateOverridden: result.gate.overridden === true
								}
							: {})
					});
					// Hits, learning and override bookkeeping never make the answer wait.
					if (result.gate) afterSmallTalkGate(result.gate, lastUser.content);
				}
				const caps = await modelCaps(body.provider, body.model);
				const toolsEnabled = caps.tools && hasFetchableFolderSkills('chat');
				// Whether a corrupted answer may be continued from its clean prefix instead
				// of regenerated (resume-plan.ts) — Ollama + a verified model family only.
				const resumeSupported = await supportsPrefixResume(body.provider, body.model);
				const basePromptMessages = await buildPromptMessages(body.messages, sources, allowedLanguages, v, body.mode ?? 'free_chat', {
					toolsEnabled,
					responseLanguage,
					numCtx: servedContext(body.provider, body.model)
				});

				for (let attempt = 0; ; attempt++) {
					// Reset fresh every attempt, not just attempt 0 — a
					// corruption/empty-answer retry throws away whatever the prior
					// attempt streamed (see the `send({type:'regenerate'})` below),
					// and that must include any tool round-trips it accumulated too,
					// not just the visible text.
					let promptMessages = [...basePromptMessages];
					let toolRoundTrips = 0;

					if (attempt > 0) {
						// A prior attempt hit U+FFFD or came back empty — throw away
						// whatever it streamed and tell the client to do the same
						// before new deltas arrive.
						finalContent = '';
						finalThinking = '';
						send({ type: 'regenerate' });
						send(noticeEvent(retryReason === 'empty' ? 'CHAT_EMPTY_ANSWER_RETRY' : 'CHAT_CORRUPTION_RETRY'));
					}

					// Per-attempt signal, not `flight.signal` directly — abort() is
					// one-way, so aborting to cancel just this attempt would also
					// permanently kill `flight` and break the next retry. Still
					// cancels immediately if `flight` itself is aborted (client
					// disconnect / superseded by a second message).
					// `let`: a resume replaces it (the previous signal was aborted to stop the
					// corrupted stream); onFlightAbort reads the variable, so it always cancels
					// whichever controller is current.
					let attemptController = new AbortController();
					const onFlightAbort = () => attemptController.abort();
					if (flight.signal.aborted) attemptController.abort();
					else flight.signal.addEventListener('abort', onFlightAbort);

					let corrupted = false;
					// Corruption recovery (resume-plan.ts). A corrupted chunk in plain answer text
					// is recovered by continuing from the clean text already shown instead of
					// regenerating from scratch. `pendingResume` carries the seam from the moment a
					// corruption is found to the next model call; `trimmer` then removes the part of
					// the model's continuation the user has already seen.
					let resumesUsed = 0;
					let pendingResume: SeamPlan | null = null;
					let trimmer: SeamTrimmer | null = null;
					let resumeKind: CorruptionKind | undefined;
					const attemptStartedAt = Date.now();
					// The seam of the request in flight, so a miss can be retried with it.
					let activeSeam: SeamPlan | null = null;
					const logSeamMiss = (action: 'resume_retry' | 'resume_mismatch') =>
						logAppEvent({
							kind: 'output_corruption',
							chatId,
							provider: body.provider,
							model: body.model,
							message: 'resume did not line up',
							action,
							corruptKind: resumeKind,
							charIndex: finalContent.length,
							keptChars: action === 'resume_retry' ? finalContent.length : 0,
							elapsedMs: Date.now() - attemptStartedAt,
							resumeCount: resumesUsed
						});
					// A resumed stream whose first words did not match what the user already saw.
					// Nothing was shown yet, so trying the same seam again is invisible (the model
					// samples afresh); only when the tries run out does it fall back to a restart.
					// Returns the decision; the caller applies it (no state is assigned in here).
					const decideSeamMiss = (): 'retry' | 'restart' => {
						if (activeSeam && canRetryResume(resumesUsed)) {
							logSeamMiss('resume_retry');
							return 'retry';
						}
						logSeamMiss('resume_mismatch');
						return 'restart';
					};
					try {
						// Normally runs once. Loops again only when the model asks to
						// read a skill's supporting file (hopToolCalls non-empty) — the
						// server executes the read(s), appends the result(s) as 'tool'
						// messages, and calls the model again with the extended
						// promptMessages, up to MAX_TOOL_ROUNDTRIPS times per attempt.
						// See skillTool.ts for what a tool call actually does.
						while (true) {
							let hopContent = '';
							const hopToolCalls: { id: string; name: string; arguments: Record<string, unknown> }[] = [];
							// A resumed request continues the partial answer: the clean text so far goes
							// in as a trailing assistant message, no tools are offered (a resume is only
							// planned when the answer had no tool activity), and the stop strings end the
							// stream where qwen3 would otherwise restart the answer inside a fake <think>
							// block. See resume-plan.ts for what was verified.
							const resumeSeam: SeamPlan | null = pendingResume;
							activeSeam = resumeSeam;
							pendingResume = null;
							trimmer = resumeSeam ? createSeamTrimmer(resumeSeam.tail) : null;
							const requestMessages: ProviderChatMessage[] = resumeSeam
								? [...promptMessages, { role: 'assistant', content: resumeSeam.prompt }]
								: promptMessages;
							const attachTools = !resumeSeam && toolsEnabled && toolRoundTrips < MAX_TOOL_ROUNDTRIPS;

							for await (const event of chatWithFallback(
								'chat',
								{
									model: body.model,
									messages: requestMessages,
									think: body.think ?? false,
									maxOutputTokens: CHAT_MAX_OUTPUT_TOKENS,
									...(attachTools ? { tools: [READ_SKILL_FILE_TOOL] } : {}),
									...(resumeSeam ? { continuation: true, stop: [...RESUME_STOP] } : {})
								},
								attemptController.signal,
								body.provider
							)) {
								if (event.type === 'reasoning') {
									const bad = findCorruption(event.text, languagesForCorruptionCheck);
									if (bad) {
										// Thinking text is never resumed (resume-plan.ts planRecovery).
										logAppEvent({
											kind: 'output_corruption',
											chatId,
											provider: body.provider,
											model: body.model,
											message: 'corrupted reasoning chunk',
											corruptKind: bad.kind,
											charIndex: finalThinking.length + bad.index,
											keptChars: 0,
											elapsedMs: Date.now() - attemptStartedAt,
											action: 'restart',
											restartReason: 'reasoning',
											resumeCount: resumesUsed
										});
										corrupted = true;
										attemptController.abort();
										break;
									}
									finalThinking += event.text;
									send({ type: 'thinking', content: event.text });
								} else if (event.type === 'text') {
									let text = event.text;
									if (trimmer) {
										// First words of a resumed stream: drop what the user has already seen.
										const seam = trimmer.push(text);
										if (seam.status === 'mismatch') {
											if (decideSeamMiss() === 'retry') {
												pendingResume = activeSeam;
												resumesUsed++;
											} else {
												corrupted = true;
											}
											attemptController.abort();
											break;
										}
										text = seam.emit;
										if (seam.status === 'ok') trimmer = null;
									}
									const bad = text ? findCorruption(text, languagesForCorruptionCheck) : null;
									if (bad) {
										const clean = text.slice(0, bad.index);
										const displayed = finalContent + clean;
										const plan = planRecovery({
											where: 'text',
											thinkRequested: body.think === true,
											hasThinking: finalThinking !== '',
											toolRoundTrips,
											hopHadToolCall: hopToolCalls.length > 0,
											resumesUsed,
											displayed,
											supportsResume: resumeSupported
										});
										logAppEvent({
											kind: 'output_corruption',
											chatId,
											provider: body.provider,
											model: body.model,
											message: 'corrupted answer chunk',
											corruptKind: bad.kind,
											charIndex: displayed.length,
											keptChars: plan.action === 'resume' ? displayed.length : 0,
											elapsedMs: Date.now() - attemptStartedAt,
											action: plan.action,
											...(plan.action === 'restart' ? { restartReason: plan.reason } : {}),
											resumeCount: resumesUsed
										});
										if (plan.action === 'resume') {
											// Show the clean part of this chunk, keep everything so far, and
											// ask the model to continue from the last word boundary.
											if (clean) {
												finalContent += clean;
												hopContent += clean;
												send({ type: 'delta', content: clean });
											}
											pendingResume = plan.seam;
											resumeKind = bad.kind;
											resumesUsed++;
											send(noticeEvent('CHAT_CORRUPTION_RESUME'));
										} else {
											corrupted = true;
										}
										attemptController.abort();
										break;
									}
									if (text) {
										finalContent += text;
										hopContent += text;
										send({ type: 'delta', content: text });
									}
								} else if (event.type === 'tool_call') {
									hopToolCalls.push({ id: event.id, name: event.name, arguments: event.arguments });
								} else if (event.type === 'notice') {
									send({ type: 'notice', message: event.message, code: event.code, params: event.params });
									logAppEvent({ kind: 'fallback', chatId, message: event.message });
								} else if (event.type === 'usage') {
									if (isNearCtxLimit(event)) nearCtxLimit = true;
									// `attempt` and `retryReason` (why the PREVIOUS attempt was
									// thrown away) make corruption/empty retries countable from
									// the log; `toolRoundTrips` does the same for read_skill_file
									// hops, `resumeCount` for continuations from a clean prefix.
									// An attempt aborted for corruption never reaches its final
									// line, so it logs no timing — the output_corruption record
									// (with elapsedMs) covers that time instead.
									logAppEvent({
										kind: 'llm_timing',
										chatId,
										provider: body.provider,
										model: body.model,
										message: 'usage',
										promptTokens: event.prompt,
										completionTokens: event.completion,
										promptMs: event.promptMs,
										completionMs: event.completionMs,
										loadMs: event.loadMs,
										numCtx: event.numCtx,
										nearCtxLimit,
										attempt,
										toolRoundTrips,
										resumeCount: resumesUsed,
										...(retryReason ? { retryReason } : {})
									});
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

							// The stream ended while a resumed answer was still waiting to line up with
							// what the user saw (the model wrote nothing, or stopped inside the partial
							// word): an unusable seam, so fall back to the full restart.
							if (trimmer && !corrupted && !pendingResume) {
								const end = trimmer.finish();
								trimmer = null;
								if (end.status === 'mismatch') {
									if (decideSeamMiss() === 'retry') {
										pendingResume = activeSeam;
										resumesUsed++;
									} else {
										corrupted = true;
									}
								}
							}

							// A corrupted chunk was recovered by resuming: ask the model again from the
							// clean text, with a fresh signal (the previous one was aborted to stop the
							// bad stream). Bounded by MAX_RESUMES in planRecovery.
							if (pendingResume && !corrupted) {
								attemptController = new AbortController();
								if (flight.signal.aborted) attemptController.abort();
								continue;
							}

							if (corrupted || hopToolCalls.length === 0) break;

							// The model asked for one or more files — collect them into ONE
							// assistant message (matches how Ollama/OpenAI expect a single
							// assistant turn to carry every tool_call it made), then one
							// 'tool' message per result, then hop again.
							promptMessages = [
								...promptMessages,
								{ role: 'assistant', content: hopContent, tool_calls: hopToolCalls }
							];
							for (const call of hopToolCalls) {
								const skill = typeof call.arguments.skill === 'string' ? call.arguments.skill : '';
								const path = typeof call.arguments.path === 'string' ? call.arguments.path : '';
								send({ type: 'toolCall', skill, path });
								const result = executeReadSkillFile(call.arguments);
								send({
									type: 'toolResult',
									skill,
									path,
									ok: result.ok,
									error: result.ok ? undefined : result.error
								});
								promptMessages = [
									...promptMessages,
									{
										role: 'tool',
										tool_call_id: call.id,
										name: call.name,
										content: result.ok ? result.content : `HATA: ${result.error}`
									}
								];
							}
							toolRoundTrips++;
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
							send(noticeEvent('CHAT_CORRUPTION_GAVE_UP'));
							logAppEvent({ kind: 'chat_error', chatId, message: 'U+FFFD corruption persisted after retries' });
						} else {
							// Genuinely empty after every retry — an `error` event, not
							// `done`, and we skip `done` below entirely: sending both
							// left the empty assistant bubble on screen right next to
							// the error text, which is what silently saving it as a
							// blank message looked like from the user's side.
							send(errorEvent('CHAT_NO_ANSWER'));
							logAppEvent({ kind: 'chat_error', chatId, message: 'empty answer persisted after retries' });
							exhaustedEmpty = true;
						}
						break;
					}
				}
				if (!exhaustedEmpty) {
					const hedges = computeHedges();
					send({
						type: 'done',
						sources,
						narrowScope,
						smallTalk: smallTalk || undefined,
						hedges: hedges.length ? hedges : undefined,
						nearCtxLimit: nearCtxLimit || undefined,
						embeddingIssue
					});
				}
			} catch (err) {
				// User-initiated stop (interrupt button / navigation) — propagates from
				// the aborted Ollama fetch. Not a real error; say nothing.
				if (!(err instanceof DOMException && err.name === 'AbortError')) {
					// A local server not running (Ollama, LM Studio, llama.cpp ... — any provider that is
					// local by kind or by its `local` flag) is this product's single most likely failure
					// mode — its own actionable code, naming the provider, rather than the generic
					// PROVIDER_NETWORK/PROVIDER_TIMEOUT_CONNECT sentence.
					let unreachableLabel: string | null = null;
					try {
						unreachableLabel = unreachableLocalServerLabel(err, readProvidersFile().providers);
					} catch {
						// An unreadable providers.json falls through to the generic error below.
					}
					// A chats.db failure (better-sqlite3's SqliteError: SQLITE_NOTADB, SQLITE_CORRUPT, ...)
					// gets its own code instead of UNKNOWN — the user can act on "couldn't save the chat".
					const sqliteCode = (err as { code?: unknown } | null)?.code;
					const dbFailure = typeof sqliteCode === 'string' && sqliteCode.startsWith('SQLITE_');
					const payload =
						unreachableLabel !== null
							? errorEvent('LOCAL_SERVER_UNREACHABLE', { provider: unreachableLabel })
							: dbFailure
								? errorEvent('CHAT_SAVE_FAILED', { detail: err instanceof Error ? err.message : String(err) })
								: { type: 'error' as const, ...errorPayload(err) };
					send(payload);
					errorSent = true;
					logAppEvent({ kind: 'chat_error', chatId, message: err instanceof Error ? err.message : String(err) });
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
							body.titleProvider ?? body.provider,
							allowedLanguages.length ? allowedLanguages[0] : undefined
						);
					}
				} catch (err) {
					const detail = err instanceof Error ? err.message : String(err);
					logAppEvent({ kind: 'db_error', chatId, message: detail });
					if (!errorSent) send(errorEvent('CHAT_SAVE_FAILED', { detail }));
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
