<script lang="ts">
	import { onDestroy, onMount, untrack } from 'svelte';
	import type { ChatMessage, ChatRequestBody, ProviderModelOption, StreamEvent } from '$lib/types';
	import Message from './Message.svelte';
	import ScopeIndicator from './ScopeIndicator.svelte';
	import ModelPickerRow from './ModelPickerRow.svelte';
	import { settings } from '$lib/settings.svelte';
	import { parseSelectionKey } from '$lib/model-selection';
	import { t } from '$lib/i18n/index.svelte';
	import { localizeError, readResponseError } from '$lib/server-error';
	import { takePendingMessage } from '$lib/pending-message';
	import { MAX_PHRASE_CHARS } from '$lib/smalltalk-limits';
	import ArrowDownIcon from '@lucide/svelte/icons/arrow-down';
	import SendIcon from '@lucide/svelte/icons/send';
	import SquareIcon from '@lucide/svelte/icons/square';
	import ArrowRightIcon from '@lucide/svelte/icons/arrow-right';

	let {
		chatId,
		vaultId,
		includedPaths,
		selectedCount = 0,
		totalCount = 0,
		onChatLoaded,
		onExpandScope,
		onFocusTree
	}: {
		chatId: string;
		vaultId: string;
		includedPaths?: string[];
		selectedCount?: number;
		totalCount?: number;
		onChatLoaded?: (paths: string[] | undefined) => void;
		onExpandScope?: () => void;
		onFocusTree?: () => void;
	} = $props();

	const FLUSH_INTERVAL_MS = 50;
	const STICK_THRESHOLD_PX = 80;

	let messages = $state<ChatMessage[]>([]);
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
			if (res.ok) messages[i].taughtSmallTalk = true;
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
	<header>
		<ScopeIndicator selected={selectedCount} total={totalCount} onFocusTree={() => onFocusTree?.()} />
	</header>

	<div class="messages-wrap">
		<div class="messages" bind:this={listEl} onscroll={handleScroll}>
			{#if messages.length === 0}
				<div class="empty-state">
					<svg class="empty-art" viewBox="0 0 96 96" aria-hidden="true" focusable="false">
						<circle cx="48" cy="48" r="44" class="ring ring-outer" />
						<circle cx="48" cy="48" r="30" class="ring ring-mid" />
						<circle cx="48" cy="48" r="3" class="core" />
						<g class="rays">
							<line x1="48" y1="2" x2="48" y2="14" />
							<line x1="48" y1="82" x2="48" y2="94" />
							<line x1="2" y1="48" x2="14" y2="48" />
							<line x1="82" y1="48" x2="94" y2="48" />
							<line x1="15.5" y1="15.5" x2="24" y2="24" />
							<line x1="72" y1="72" x2="80.5" y2="80.5" />
							<line x1="80.5" y1="15.5" x2="72" y2="24" />
							<line x1="24" y1="72" x2="15.5" y2="80.5" />
						</g>
					</svg>
					<h2>{t('Chat.emptyStateTitle')}</h2>
					<p>{t('Chat.emptyStateSubtitle')}</p>
					{#if onFocusTree}
						<button type="button" class="empty-action" onclick={() => onFocusTree?.()}>
							{t('Chat.emptyStateBrowseSources')}
							<ArrowRightIcon size={13} aria-hidden="true" />
						</button>
					{/if}
				</div>
			{/if}
			{#each messages as message, i (message.id)}
				<Message
					{message}
					{vaultId}
					streaming={isStreaming && i === messages.length - 1}
					{onExpandScope}
					onForceSources={message.smallTalk ? () => retryWithSources(i) : undefined}
					onNotRelevant={message.sources?.length && canTeach(i) ? () => teachNotRelevant(i) : undefined}
				/>
			{/each}
		</div>
		{#if isStreaming && !isAtBottom}
			<button class="scroll-to-bottom" onclick={() => scrollToBottom(true)}>
				<ArrowDownIcon size={14} aria-hidden="true" /> {t('Chat.scrollToBottom')}
			</button>
		{/if}
	</div>

	{#if errorMessage}
		<p class="error" role="alert">{errorMessage}</p>
	{/if}

	<ModelPickerRow
		idPrefix="model"
		{modelOptions}
		{activeProvider}
		{activeModel}
		bind:thinkMode
		bind:reviewMode
		{onModelChange}
		{onReviewModeChange}
		class="chat-compose-row"
	/>

	<footer>
		<textarea
			id="chat-input"
			name="chat-input"
			bind:value={input}
			onkeydown={handleKeydown}
			placeholder={t('Chat.inputPlaceholder')}
			disabled={isStreaming}
		></textarea>
		{#if isStreaming}
			<button class="stop" onclick={stop} aria-label={t('Chat.stop')}>
				<SquareIcon size={16} aria-hidden="true" />
				{t('Chat.stop')}
			</button>
		{:else}
			<button onclick={send} disabled={!input.trim()} aria-label={t('Chat.send')}>
				<SendIcon size={16} aria-hidden="true" />
				{t('Chat.send')}
			</button>
		{/if}
	</footer>
</div>

<style>
	.chat {
		display: flex;
		flex-direction: column;
		height: 100%;
	}

	header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		padding: 0.5rem 1rem;
		border-bottom: 1px solid var(--color-border);
	}

	/* .compose-controls/.model-pill/.think-pill now live in
	   ModelPickerRow.svelte (used here and by vault/[id]/+page.svelte's
	   new-chat composer, which used to duplicate this whole block) —
	   Svelte's style scoping is per-component-template, so reaching the
	   child's root element for this one extra bit of layout (this page's
	   own top padding, not something the shared row should own) needs
	   :global() rather than a plain class rule. */
	:global(.chat-compose-row) {
		padding: 0.6rem 1rem 0;
	}

	.messages-wrap {
		position: relative;
		flex: 1;
		min-height: 0;
	}

	.messages {
		height: 100%;
		overflow-y: auto;
		padding: 1rem;
	}

	.scroll-to-bottom {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		position: absolute;
		bottom: 1rem;
		left: 50%;
		transform: translateX(-50%);
		padding: 0.4rem 0.9rem;
		border-radius: var(--radius-pill);
		border: 1px solid var(--color-border);
		background: var(--color-background);
		color: var(--color-foreground);
		font-size: 0.8rem;
		cursor: pointer;
		/* An overlay floating above scrollable content — a different case
		   from panel separation, where DESIGN.md's hairlines-not-shadows
		   principle applies. Uses the accent-glow token rather than a raw
		   rgb() value so it still ties into the system. */
		box-shadow: 0 2px 8px var(--accent-glow);
		/* Task 8 — enters with opacity + a small scale-up; the button's own
		   static translateX(-50%) centering must survive the keyframe, so
		   the keyframe repeats it alongside the scale rather than replacing
		   the transform outright. */
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

	.scroll-to-bottom:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}

	/* The one place DESIGN.md's particle-vortex/light-beam art direction is
	   allowed — an authored SVG, not a stock illustration, built from the
	   same accent/hairline tokens as everything else so it themes for free. */
	.empty-state {
		display: flex;
		flex-direction: column;
		align-items: center;
		text-align: center;
		margin-top: 3rem;
		padding: 0 1.5rem;
	}

	.empty-art {
		width: 88px;
		height: 88px;
		margin-bottom: 1.25rem;
		overflow: visible;
	}

	.empty-art .ring {
		fill: none;
		stroke: var(--hairline-accent);
		stroke-width: 1;
	}

	.empty-art .ring-mid {
		stroke: var(--accent-soft);
	}

	/* The one authored moment DESIGN.md reserves this art for — a slow,
	   even breathing on the single accent dot, not the rings or rays (one
	   material idea, not several stacked). Reads as "the vault is
	   listening" rather than decoration; automatically settles to
	   near-static under prefers-reduced-motion via app.css's global
	   animation-duration override, so no separate media query is needed
	   here. */
	.empty-art .core {
		fill: var(--accent);
		transform-box: fill-box;
		transform-origin: center;
		animation: empty-art-pulse 2600ms cubic-bezier(0.4, 0, 0.6, 1) infinite;
	}

	@keyframes empty-art-pulse {
		0%,
		100% {
			transform: scale(1);
			opacity: 1;
		}
		50% {
			transform: scale(1.35);
			opacity: 0.7;
		}
	}

	.empty-art .rays line {
		stroke: var(--accent-soft);
		stroke-width: 1;
		stroke-linecap: round;
	}

	.empty-state h2 {
		font-family: var(--font-display);
		font-weight: 480;
		letter-spacing: -0.015em;
		font-size: 1.5rem;
		color: var(--color-foreground);
		margin: 0 0 0.4rem;
	}

	.empty-state p {
		color: var(--color-muted-foreground);
		font-size: 0.875rem;
		margin: 0 0 1.25rem;
	}

	.empty-action {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		background: transparent;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-pill);
		padding: 0.4rem 0.9rem;
		color: var(--color-foreground);
		font-size: 0.8rem;
		cursor: pointer;
	}

	.empty-action:hover {
		color: var(--color-primary);
		border-color: var(--color-primary);
	}

	.empty-action:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}

	.error {
		color: var(--color-destructive);
		padding: 0 1rem;
		font-size: 0.85rem;
	}

	footer {
		display: flex;
		gap: 0.5rem;
		padding: 0.75rem 1rem;
		border-top: 1px solid var(--color-border);
	}

	textarea {
		flex: 1;
		resize: none;
		min-height: 2.5rem;
		max-height: 10rem;
		/* Pill radius (İdeas.txt: the composer read as "too rectangular")
		   on a box this short renders as fully rounded ends at min-height
		   and gracefully becomes a rounded rectangle as it grows with
		   multi-line input — no separate handling needed for either
		   state. Horizontal padding bumped up from the rounded-rect value
		   so text doesn't crowd the now-much-tighter curve. */
		padding: 0.6rem 1.1rem;
		border-radius: var(--radius-pill);
		border: 1px solid var(--color-border);
		background: var(--color-background);
		color: var(--color-foreground);
		font-family: var(--font-sans);
		font-size: 1rem;
	}

	textarea:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}

	footer button {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		padding: 0 1.4rem;
		border-radius: var(--radius-pill);
		border: none;
		background: var(--color-primary);
		color: var(--color-primary-foreground);
		font-weight: 600;
		cursor: pointer;
	}

	footer button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	footer button:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}

	footer button.stop {
		background: var(--color-destructive);
		color: var(--color-background);
	}
</style>
