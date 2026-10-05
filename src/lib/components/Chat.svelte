<script lang="ts">
	import { onDestroy, onMount, untrack, type Snippet } from 'svelte';
	import type { ChatMessage, ChatRequestBody, ProviderModelOption, StreamEvent } from '$lib/types';
	import Message from './Message.svelte';
	import ModelPickerRow from './ModelPickerRow.svelte';
	import ReindexDialog from './ReindexDialog.svelte';
	import { settings } from '$lib/settings.svelte';
	import { parseSelectionKey } from '$lib/model-selection';
	import { t } from '$lib/i18n/index.svelte';
	import { localizeError, readResponseError } from '$lib/server-error';
	import { takePendingMessage } from '$lib/pending-message';
	import { MAX_PHRASE_CHARS } from '$lib/smalltalk-limits';
	import ArrowDownIcon from '@lucide/svelte/icons/arrow-down';
	import Icon from '$lib/components/Icon.svelte';
	import ArrowRightIcon from '@lucide/svelte/icons/arrow-right';

	let {
		chatId,
		vaultId,
		includedPaths,
		onChatLoaded,
		onExpandScope,
		onFocusTree,
		onTurnEnd,
		composerStart,
		onModelLabel
	}: {
		chatId: string;
		vaultId: string;
		includedPaths?: string[];
		onChatLoaded?: (paths: string[] | undefined) => void;
		onExpandScope?: () => void;
		onFocusTree?: () => void;
		/** Fires when a send/stream finishes (success, error or abort) — the page
		 * refreshes its chat list then, since the first message creates the row. */
		onTurnEnd?: () => void;
		/** Optional content for the left end of the composer bar (the source-scope
		 * trigger is placed here by the chat page). */
		composerStart?: Snippet;
		/** Reports the active "<provider> · <model>" label (for the sidebar's
		 * Kaynaklar card) — derived from the model list this component already loads. */
		onModelLabel?: (label: string) => void;
	} = $props();

	const FLUSH_INTERVAL_MS = 50;
	const STICK_THRESHOLD_PX = 80;

	let messages = $state<ChatMessage[]>([]);
	// Aşama 3c — opened by a message's "Yeniden indeksle" action (embeddingIssue
	// === 'mismatch', see Message.svelte); one dialog instance for the whole
	// chat rather than one per message, since only one reindex can run at a
	// time for this vault anyway (reindex.ts's per-vault lock).
	let reindexDialogOpen = $state(false);
	let input = $state('');
	let thinkMode = $state(false);
	let isStreaming = $state(false);
	let errorMessage = $state('');
	let isAtBottom = $state(true);
	let listEl: HTMLDivElement | undefined;
	let abortController: AbortController | undefined;
	let modelOptions = $state<ProviderModelOption[]>([]);
	/** Per-chat model/provider override — undefined means "use the task
	 * default below", set once a chat is loaded (existing chats always
	 * carry the model they were created with) or the user explicitly
	 * picks one from the header dropdown. */
	let overrideModel = $state<string | undefined>(undefined);
	/**
	 * Faz 17 — providerId end-to-end. ChatRow.provider is null for chats
	 * created before this column existed (or where no explicit provider was
	 * ever chosen); loadChat() below falls back to undefined for those,
	 * i.e. the current task-default provider — same as always. A chat
	 * created with an explicit provider (welcome-screen picker or header
	 * dropdown) reopens pinned to that provider, so its stored `model`
	 * never gets paired with whatever provider happens to be the default
	 * *now* (the mismatch that used to surface as a confusing "model not
	 * found" from a provider whose own connection test passed fine).
	 */
	let overrideProvider = $state<string | undefined>(undefined);
	let hasChatRow = $state(false);
	/** F6 — this chat's mode toggle. Persisted to chats.mode (unlike thinkMode, which is per-request only) so
	 * reopening a review chat keeps showing it as one. See onReviewModeChange. */
	let reviewMode = $state(false);

	let activeModel = $derived(overrideModel ?? (thinkMode ? settings.reasoningModel : settings.fastModel));
	let activeProvider = $derived(
		overrideProvider ?? (thinkMode ? settings.reasoningProvider : settings.fastProvider)
	);

	$effect(() => {
		const providerLabel = modelOptions.find((m) => m.providerId === activeProvider)?.providerLabel;
		onModelLabel?.([providerLabel, activeModel].filter(Boolean).join(' · '));
	});

	async function onReviewModeChange(value: boolean) {
		reviewMode = value;
		if (hasChatRow) {
			try {
				await fetch(`/api/chats/${chatId}`, {
					method: 'PATCH',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ mode: value ? 'review' : 'free_chat' })
				});
			} catch {
				// Best-effort persistence — the in-memory toggle still applies to this session, same as onModelChange.
			}
		}
	}

	onMount(async () => {
		try {
			const res = await fetch('/api/providers/models');
			if (res.ok) modelOptions = (await res.json()) as ProviderModelOption[];
		} catch {
			// Header selector just shows the current model as a lone option — not fatal.
		}
	});

	// Navigating away (or the whole component unmounting for any other reason)
	// must stop an in-flight stream the same way the chatId-change $effect
	// below already does — that effect only fires on a same-component
	// chatId swap; a route change that tears the component down entirely
	// skipped both the abort AND the server-side flight's own single-flight
	// cleanup (the fetch just kept running, unread, until it finished on its
	// own). ask()'s own `finally` (isStreaming=false, clearInterval(timer))
	// still runs normally off the AbortError this triggers.
	onDestroy(() => abortController?.abort());

	async function onModelChange(key: string) {
		const { providerId, modelId } = parseSelectionKey(key);
		overrideModel = modelId;
		overrideProvider = providerId;
		if (hasChatRow) {
			try {
				await fetch(`/api/chats/${chatId}`, {
					method: 'PATCH',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ model: modelId, provider: providerId })
				});
			} catch {
				// Best-effort persistence — the in-memory override still applies to this session.
			}
		}
	}

	function handleScroll() {
		if (!listEl) return;
		isAtBottom =
			listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight < STICK_THRESHOLD_PX;
	}

	/** During streaming, only follow new content if the user was already at the
	 * bottom — otherwise a manual scroll-up gets yanked back down on every token. */
	function scrollToBottom(force = false) {
		if (!listEl || (!force && !isAtBottom)) return;
		queueMicrotask(() => listEl?.scrollTo({ top: listEl.scrollHeight }));
	}

	async function send() {
		const question = input.trim();
		if (!question || isStreaming) return;
		input = '';
		await ask(question);
	}

	/** The user message that produced messages[i] (the assistant answer at index i). */
	function questionBefore(i: number): string | null {
		for (let j = i - 1; j >= 0; j--) if (messages[j].role === 'user') return messages[j].content.trim();
		return null;
	}

	/** "Yine de kaynak ara": the same question again, this time with the small-talk gate bypassed. */
	function retryWithSources(i: number) {
		const question = questionBefore(i);
		if (question && !isStreaming) void ask(question, true);
	}

	/** "Kaynaklar alakasız": this short message was small talk — remember it. */
	async function teachNotRelevant(i: number) {
		const question = questionBefore(i);
		if (!question) return;
		try {
			const res = await fetch('/api/smalltalk', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ text: question })
			});
			if (res.ok) {
				const body = (await res.json().catch(() => null)) as { stored?: boolean; gateActive?: boolean } | null;
				if (body?.gateActive === false) {
					// The gate is off for this embedding model: nothing was learned, so do not claim it was.
					errorMessage = t('Chat.smallTalkUnavailable');
				} else {
					messages[i].taughtSmallTalk = true;
				}
			}
		} catch {
			// best effort: the button simply stays, the user can press it again
		}
	}

	/** Only a short message can be small talk (smalltalk-limits.ts) — otherwise no button. */
	function canTeach(i: number): boolean {
		const question = questionBefore(i);
		return question !== null && question.length > 0 && question.length <= MAX_PHRASE_CHARS;
	}

	async function ask(question: string, forceSources = false) {
		errorMessage = '';
		messages.push({ id: crypto.randomUUID(), role: 'user', content: question });
		messages.push({ id: crypto.randomUUID(), role: 'assistant', content: '' });
		// $state arrays deep-proxy their contents on push — grab the reference back
		// out of the array so later mutations hit the reactive proxy, not the
		// original plain object (which the UI never sees updates to).
		const assistantMessage = messages[messages.length - 1];
		isAtBottom = true;
		scrollToBottom(true);

		isStreaming = true;
		let rawContent = '';
		let flushedContent = '';
		let rawThinking = '';
		let flushedThinking = '';
		const flush = () => {
			let changed = false;
			if (rawContent !== flushedContent) {
				flushedContent = rawContent;
				assistantMessage.content = rawContent;
				changed = true;
			}
			if (rawThinking !== flushedThinking) {
				flushedThinking = rawThinking;
				assistantMessage.thinking = rawThinking;
				changed = true;
			}
			if (changed) scrollToBottom();
		};
		const timer = setInterval(flush, FLUSH_INTERVAL_MS);

		// Set once an in-band SSE `error` event arrives (the request itself
		// succeeded — this is the server telling us the turn failed mid-stream).
		let sawErrorEvent = false;

		// Nothing usable survived this turn (no visible answer text — thinking-
		// only or nothing at all) — pop the optimistic user+assistant bubbles
		// and hand the question back to the composer, so retrying is hitting
		// Send again, not retyping from memory. Shared by both failure paths
		// below: a thrown exception (network failure, non-ok response) and an
		// in-band `error` event the stream sent without throwing.
		function discardOptimisticTurn() {
			if (!assistantMessage.content) {
				messages.pop();
				messages.pop();
				input = question;
			}
		}

		abortController = new AbortController();
		try {
			const requestBody: ChatRequestBody = {
				messages: messages.slice(0, -1),
				model: activeModel,
				provider: activeProvider,
				think: thinkMode,
				mode: reviewMode ? 'review' : 'free_chat',
				chatId,
				titleModel: settings.defaultModel,
				titleProvider: settings.defaultProvider,
				vault: vaultId,
				includedPaths,
				forceSources: forceSources || undefined
			};
			const res = await fetch('/api/chat', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(requestBody),
				signal: abortController.signal
			});
			if (!res.ok || !res.body) throw new Error(await readResponseError(res));

			const reader = res.body.getReader();
			const decoder = new TextDecoder();
			let buffer = '';
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				const parts = buffer.split('\n\n');
				buffer = parts.pop() ?? '';
				for (const part of parts) {
					const line = part.trim();
					if (!line.startsWith('data:')) continue;
					const event = JSON.parse(line.slice(5)) as StreamEvent;
					if (event.type === 'delta') rawContent += event.content;
					else if (event.type === 'thinking') rawThinking += event.content;
					else if (event.type === 'regenerate') {
						// Server hit U+FFFD and is restarting generation from scratch —
						// discard whatever partial (possibly corrupted) content already
						// rendered. notices deliberately kept: the "regenerating" notice
						// this pairs with belongs to this message's generation history.
						rawContent = '';
						flushedContent = '';
						rawThinking = '';
						flushedThinking = '';
						assistantMessage.content = '';
						assistantMessage.thinking = '';
						// Unlike notices, these describe files fetched FOR the discarded
						// attempt's context — keeping them would misrepresent what
						// actually informed the final answer once regeneration redoes
						// (or skips) those reads.
						assistantMessage.toolCalls = [];
					}
					else if (event.type === 'done') {
						assistantMessage.sources = event.sources;
						assistantMessage.narrowScope = event.narrowScope;
						assistantMessage.smallTalk = event.smallTalk;
						assistantMessage.hedges = event.hedges;
						assistantMessage.nearCtxLimit = event.nearCtxLimit;
						assistantMessage.embeddingIssue = event.embeddingIssue;
					}
					else if (event.type === 'error') {
						errorMessage = localizeError(event);
						sawErrorEvent = true;
					}
					else if (event.type === 'notice') {
						(assistantMessage.notices ??= []).push({ message: event.message, code: event.code, params: event.params });
					}
					else if (event.type === 'toolCall') {
						(assistantMessage.toolCalls ??= []).push({
							skill: event.skill,
							path: event.path,
							status: 'reading'
						});
					}
					else if (event.type === 'toolResult') {
						const tc = assistantMessage.toolCalls?.findLast(
							(c) => c.skill === event.skill && c.path === event.path && c.status === 'reading'
						);
						if (tc) {
							tc.status = event.ok ? 'done' : 'error';
							tc.error = event.error;
						}
					}
					// Server creates the chat row before emitting this — its arrival
					// is proof a later model-override PATCH now has a row to hit.
					else if (event.type === 'chatId') hasChatRow = true;
				}
			}
			// The stream ended normally (no exception) but carried an in-band
			// `error` event and nothing usable came out of it — same recovery
			// as the exception path below.
			if (sawErrorEvent && !assistantMessage.content) discardOptimisticTurn();
		} catch (err) {
			// User-initiated stop — keep whatever partial answer already streamed in,
			// don't show it as an error. Mark it so Message.svelte can show something
			// other than a blank bubble if nothing had streamed in yet (e.g. stopped
			// during the thinking phase, before any answer content arrived).
			if (err instanceof DOMException && err.name === 'AbortError') {
				assistantMessage.interrupted = true;
			} else {
				errorMessage = err instanceof Error ? err.message : t('Common.bilinmeyenHata');
				discardOptimisticTurn();
			}
		} finally {
			clearInterval(timer);
			flush();
			isStreaming = false;
			abortController = undefined;
			onTurnEnd?.();
		}
	}

	function stop() {
		abortController?.abort();
	}

	async function loadChat(id: string) {
		errorMessage = '';
		try {
			const res = await fetch(`/api/chats/${id}`);
			if (res.status === 404) {
				// A brand-new chat has no row yet — the server only creates one
				// once the first message is actually sent (see +page.svelte's
				// own comment on this same 404). Not a failure: just an empty,
				// unsent chat.
				messages = [];
				overrideModel = undefined;
				overrideProvider = undefined;
				reviewMode = false;
				hasChatRow = false;
				onChatLoaded?.(undefined);
				return;
			}
			if (!res.ok) throw new Error();
			const data = (await res.json()) as {
				chat: { model: string; provider: string | null; included_paths_json: string | null; mode: string };
				messages: ChatMessage[];
			};
			messages = data.messages;
			overrideModel = data.chat.model;
			// null (pre-migration chats, or none ever chosen) → undefined, same
			// fallback-to-current-default as before — see its doc comment.
			overrideProvider = data.chat.provider ?? undefined;
			reviewMode = data.chat.mode === 'review';
			hasChatRow = true;
			isAtBottom = true;
			scrollToBottom(true);
			onChatLoaded?.(
				data.chat.included_paths_json ? (JSON.parse(data.chat.included_paths_json) as string[]) : undefined
			);
		} catch {
			errorMessage = t('Chat.chatLoadError');
		}
	}

	// Re-runs whenever the chatId prop changes (not just on first mount) — a
	// SvelteKit navigation between two /chat/[id] routes can reuse the same
	// component instance, so onMount alone would miss that.
	$effect(() => {
		const id = chatId;
		// A stream from the previously-viewed chat must not keep running
		// against this one after navigating away — left alone, isStreaming
		// stays true and locks the new chat's composer until the old,
		// now-invisible stream finishes on its own, and its "Durdur" button
		// would silently stop a chat the user isn't even looking at.
		abortController?.abort();
		const pending = takePendingMessage(id);
		if (pending) {
			// A choice made on the welcome screen's own model/provider/think
			// picker (see pending-message.ts) applies to this one new chat —
			// undefined for any of these just falls through to today's
			// default (activeModel/activeProvider's own ?? fallback below).
			overrideModel = pending.modelId;
			overrideProvider = pending.providerId;
			if (pending.think !== undefined) thinkMode = pending.think;
			reviewMode = pending.mode === 'review';
			hasChatRow = false;
			onChatLoaded?.(undefined);
			input = pending.question;
			// untrack is load-bearing, not defensive: send() is async but runs
			// synchronously up to its first `await`, and that synchronous prefix
			// reads `isStreaming` (its early-return guard). Svelte 5 tracks any
			// reactive read that happens synchronously inside an effect's call
			// graph — including inside a function the effect merely calls — so
			// without untrack this effect silently subscribes to isStreaming too.
			// When send()'s `finally` later flips isStreaming back to false at
			// stream end, that re-triggers this whole effect; takePendingMessage
			// is already spent by then, so it falls into the `else` branch and
			// fires an unsolicited loadChat() right as the server may still be
			// persisting the assistant's row — replacing the live, correctly
			// streamed messages with an incomplete DB snapshot. That was the
			// "reply never appears until I reload" bug, and it only ever hit a
			// brand-new chat's first message because only this path calls send()
			// from inside an effect at all.
			untrack(() => send());
		} else {
			loadChat(id);
		}
	});

	function handleKeydown(e: KeyboardEvent) {
		// An IME composing a candidate (Japanese/Chinese/Korean input, etc.)
		// fires its own Enter to commit the candidate — that must not also
		// submit the message. keyCode 229 is the older/Safari signal for the
		// same state on engines that don't set isComposing.
		if (e.isComposing || e.keyCode === 229) return;
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			send();
		}
	}
</script>

<div class="chat">
	<div class="messages-wrap">
		<div class="messages" bind:this={listEl} onscroll={handleScroll}>
			{#if messages.length === 0}
				<div class="vc-empty">
					<h1>{t('Chat.emptyStateTitle')}</h1>
					<p>{t('Chat.emptyStateSubtitle')}</p>
					{#if onFocusTree}
						<button type="button" class="vc-btn secondary" onclick={() => onFocusTree?.()}>
							{t('Chat.emptyStateBrowseSources')}
							<ArrowRightIcon size={20} strokeWidth={1.75} aria-hidden="true" />
						</button>
					{/if}
				</div>
			{/if}
			<div class="thread">
				{#each messages as message, i (message.id)}
					<Message
						{message}
						{vaultId}
						streaming={isStreaming && i === messages.length - 1}
						{onExpandScope}
						onForceSources={message.smallTalk ? () => retryWithSources(i) : undefined}
						onNotRelevant={message.sources?.length && canTeach(i) ? () => teachNotRelevant(i) : undefined}
						onReindex={message.embeddingIssue === 'mismatch' ? () => (reindexDialogOpen = true) : undefined}
					/>
				{/each}
			</div>
		</div>
		{#if isStreaming && !isAtBottom}
			<button
				type="button"
				class="vc-icon-btn scroll-to-bottom"
				onclick={() => scrollToBottom(true)}
				aria-label={t('Chat.scrollToBottom')}
				title={t('Chat.scrollToBottom')}
			>
				<ArrowDownIcon size={20} strokeWidth={1.75} aria-hidden="true" />
			</button>
		{/if}
	</div>

	{#if errorMessage}
		<p class="error" role="alert">{errorMessage}</p>
	{/if}

	<footer>
		<div class="vc-composer">
			<textarea
				id="chat-input"
				name="chat-input"
				rows="1"
				bind:value={input}
				onkeydown={handleKeydown}
				placeholder={t('Chat.inputPlaceholder')}
				disabled={isStreaming}
			></textarea>
			<div class="vc-composer-bar">
				<!-- Left slot: the chat page puts its SourceTrigger here (composerStart). -->
				{@render composerStart?.()}
				<ModelPickerRow
					idPrefix="model"
					{modelOptions}
					{activeProvider}
					{activeModel}
					bind:thinkMode
					bind:reviewMode
					{onModelChange}
					{onReviewModeChange}
					class="composer-tools"
				/>
				<span class="spacer"></span>
				{#if isStreaming}
					<button type="button" class="vc-send stop" onclick={stop} aria-label={t('Chat.stop')} title={t('Chat.stop')}></button>
				{:else}
					<button
						type="button"
						class="vc-send"
						onclick={send}
						disabled={!input.trim()}
						aria-label={t('Chat.send')}
						title={t('Chat.send')}
					>
						<Icon name="send" />
					</button>
				{/if}
			</div>
		</div>
	</footer>
</div>

<ReindexDialog vaultId={vaultId} bind:open={reindexDialogOpen} />

<style>
	.chat {
		display: flex;
		flex-direction: column;
		height: 100%;
		background: var(--bg-canvas);
	}

	.messages-wrap {
		position: relative;
		flex: 1;
		min-height: 0;
	}

	.messages {
		height: 100%;
		overflow-y: auto;
		padding: var(--space-4);
	}

	/* Transcript column: centered at the reading measure, messages spaced by
	   --space-6. */
	.thread {
		display: flex;
		flex-direction: column;
		gap: var(--space-6);
		width: 100%;
		max-width: var(--reading-measure);
		margin-inline: auto;
	}

	.scroll-to-bottom {
		position: absolute;
		bottom: var(--space-4);
		left: 50%;
		transform: translateX(-50%);
		width: 36px;
		height: 36px;
		border-radius: var(--radius-full);
		background: var(--bg-elevated);
		color: var(--label);
		box-shadow: var(--shadow-popover);
		/* Enters with opacity + a small scale-up; the static translateX(-50%)
		   centering must survive the keyframe. */
		animation: scroll-to-bottom-enter var(--motion-fast) var(--motion-easing);
	}

	@keyframes scroll-to-bottom-enter {
		from {
			opacity: 0;
			transform: translateX(-50%) scale(0.96);
		}
		to {
			opacity: 1;
			transform: translateX(-50%) scale(1);
		}
	}

	.scroll-to-bottom:focus-visible,
	.vc-send:focus-visible,
	.vc-empty .vc-btn:focus-visible {
		outline: 2px solid var(--focus-ring);
		outline-offset: 2px;
	}

	.error {
		color: var(--danger);
		width: 100%;
		max-width: var(--reading-measure);
		margin: 0 auto;
		padding: 0 var(--space-4);
		font-size: 0.85rem;
	}

	footer {
		display: flex;
		justify-content: center;
		padding: var(--space-3) var(--space-4) var(--space-4);
	}

	.vc-composer textarea {
		field-sizing: content;
		max-height: 10rem;
		overflow-y: auto;
	}
	/* The composer's own :focus-within ring is the focus indicator; the
	   textarea's .vc-root :focus-visible outline would draw a second box. */
	.vc-composer textarea:focus-visible {
		outline: none;
	}

	.vc-composer textarea:disabled {
		color: var(--label-tertiary);
	}

	.vc-composer-bar {
		flex-wrap: wrap;
	}

	/* ModelPickerRow brings its own layout; inside the bar it only needs to
	   shrink gracefully next to the slot and the send button. */
	.vc-composer-bar :global(.composer-tools) {
		padding: 0;
		min-width: 0;
	}
</style>
