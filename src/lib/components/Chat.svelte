<script lang="ts">
	import { onMount } from 'svelte';
	import type { ChatMessage, ChatRequestBody, ProviderModelOption, StreamEvent } from '$lib/types';
	import Message from './Message.svelte';
	import ScopeIndicator from './ScopeIndicator.svelte';
	import { settings } from '$lib/settings.svelte';
	import { t } from '$lib/i18n/index.svelte';
	import { takePendingMessage } from '$lib/pending-message';
	import ArrowDownIcon from '@lucide/svelte/icons/arrow-down';
	import SendIcon from '@lucide/svelte/icons/send';
	import SquareIcon from '@lucide/svelte/icons/square';
	import BotIcon from '@lucide/svelte/icons/bot';
	import BrainIcon from '@lucide/svelte/icons/brain';
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
	 * Faz 17 — providerId end-to-end. Unlike overrideModel, an EXISTING
	 * chat's row (chats-db's ChatRow) never stored a provider — the concept
	 * didn't exist before this — so loadChat() below deliberately leaves
	 * this undefined when restoring a chat, falling back to the current
	 * task-default provider rather than a value that was never really
	 * there. Only the header dropdown (a fresh, in-session choice) sets it.
	 */
	let overrideProvider = $state<string | undefined>(undefined);
	let hasChatRow = $state(false);

	let activeModel = $derived(overrideModel ?? (thinkMode ? settings.reasoningModel : settings.fastModel));
	let activeProvider = $derived(
		overrideProvider ?? (thinkMode ? settings.reasoningProvider : settings.fastProvider)
	);

	// A plain model id can't carry which provider it came from on its own
	// (two providers could serve identically-named models), and the native
	// <select> below binds a single string value — same U+241F-separator
	// encoding as /settings/+page.svelte's model selectors, see its comment.
	function selectionKey(providerId: string, modelId: string): string {
		return `${providerId}␟${modelId}`;
	}
	function parseSelectionKey(key: string): { providerId: string; modelId: string } {
		const [providerId, modelId] = key.split('␟');
		return { providerId, modelId };
	}

	onMount(async () => {
		try {
			const res = await fetch('/api/providers/models');
			if (res.ok) modelOptions = (await res.json()) as ProviderModelOption[];
		} catch {
			// Header selector just shows the current model as a lone option — not fatal.
		}
	});

	async function onModelChange(key: string) {
		const { providerId, modelId } = parseSelectionKey(key);
		overrideModel = modelId;
		overrideProvider = providerId;
		if (hasChatRow) {
			try {
				// Only `model` persists to chats-db (no provider column exists —
				// see overrideProvider's doc comment above); the provider choice
				// stays in-memory for this session only.
				await fetch(`/api/chats/${chatId}`, {
					method: 'PATCH',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ model: modelId })
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

		errorMessage = '';
		input = '';
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

		abortController = new AbortController();
		try {
			const requestBody: ChatRequestBody = {
				messages: messages.slice(0, -1),
				model: activeModel,
				provider: activeProvider,
				think: thinkMode,
				chatId,
				titleModel: settings.defaultModel,
				vault: vaultId,
				includedPaths
			};
			const res = await fetch('/api/chat', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(requestBody),
				signal: abortController.signal
			});
			if (!res.ok || !res.body) throw new Error(t('Common.istekBasarisiz', { status: res.status }));

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
					}
					else if (event.type === 'done') {
						assistantMessage.sources = event.sources;
						assistantMessage.narrowScope = event.narrowScope;
						assistantMessage.hedges = event.hedges;
					}
					else if (event.type === 'error') errorMessage = event.message;
					else if (event.type === 'notice') {
						(assistantMessage.notices ??= []).push(event.message);
					}
					// Server creates the chat row before emitting this — its arrival
					// is proof a later model-override PATCH now has a row to hit.
					else if (event.type === 'chatId') hasChatRow = true;
				}
			}
		} catch (err) {
			// User-initiated stop — keep whatever partial answer already streamed in,
			// don't show it as an error. Mark it so Message.svelte can show something
			// other than a blank bubble if nothing had streamed in yet (e.g. stopped
			// during the thinking phase, before any answer content arrived).
			if (err instanceof DOMException && err.name === 'AbortError') {
				assistantMessage.interrupted = true;
			} else {
				errorMessage = err instanceof Error ? err.message : t('Common.bilinmeyenHata');
				if (!assistantMessage.content) {
					// Nothing ever streamed in (e.g. Ollama unreachable at connect
					// time) — an empty bubble would just be a second, disconnected
					// place this same error shows up, and the question is still
					// visible below in the input rather than lost. Undo the
					// optimistic push entirely and restore the input so retrying
					// is hitting Send again, not retyping the question from memory.
					messages.pop();
					messages.pop();
					input = question;
				}
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
				hasChatRow = false;
				onChatLoaded?.(undefined);
				return;
			}
			if (!res.ok) throw new Error();
			const data = (await res.json()) as {
				chat: { model: string; included_paths_json: string | null };
				messages: ChatMessage[];
			};
			messages = data.messages;
			overrideModel = data.chat.model;
			// overrideProvider intentionally NOT set here — see its doc comment.
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
		const pendingQuestion = takePendingMessage(id);
		if (pendingQuestion) {
			overrideModel = undefined;
			overrideProvider = undefined;
			hasChatRow = false;
			onChatLoaded?.(undefined);
			input = pendingQuestion;
			send();
		} else {
			loadChat(id);
		}
	});

	function handleKeydown(e: KeyboardEvent) {
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
				<Message {message} {vaultId} streaming={isStreaming && i === messages.length - 1} {onExpandScope} />
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

	<div class="compose-controls">
		<label class="model-pill" for="model-select">
			<span class="sr-only">{t('Chat.modelSrLabel')}</span>
			<BotIcon size={13} aria-hidden="true" />
			<select
				id="model-select"
				title={t('Chat.modelSelectTitle')}
				value={selectionKey(activeProvider, activeModel)}
				onchange={(e) => onModelChange(e.currentTarget.value)}
			>
				{#if !modelOptions.some((m) => m.providerId === activeProvider && m.id === activeModel)}
					<option value={selectionKey(activeProvider, activeModel)}>{activeModel}</option>
				{/if}
				{#each modelOptions as m (m.providerId + '/' + m.id)}
					<option value={selectionKey(m.providerId, m.id)}>{m.providerLabel} · {m.id}</option>
				{/each}
			</select>
		</label>
		<label
			class="think-pill"
			class:active={thinkMode}
			for="think-mode"
			title={t('Chat.thinkModeTitle')}
		>
			<input id="think-mode" name="think-mode" type="checkbox" bind:checked={thinkMode} class="sr-only" />
			<BrainIcon size={13} aria-hidden="true" />
			{t('Chat.thinkModeLabel')}
		</label>
	</div>

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

	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border: 0;
	}

	.compose-controls {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.6rem 1rem 0;
	}

	.model-pill,
	.think-pill {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		background: var(--color-secondary);
		color: var(--color-secondary-foreground);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-pill);
		padding: 0.3rem 0.7rem;
		font-size: 0.75rem;
	}

	.model-pill {
		max-width: 240px;
	}

	.model-pill select {
		appearance: none;
		border: none;
		background: transparent;
		color: inherit;
		font-family: var(--font-sans);
		font-size: 0.75rem;
		max-width: 190px;
		overflow: hidden;
		text-overflow: ellipsis;
		cursor: pointer;
	}

	.model-pill:focus-within {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}

	.model-pill :global(svg) {
		flex-shrink: 0;
		color: var(--color-muted-foreground);
	}

	.think-pill {
		color: var(--color-muted-foreground);
		cursor: pointer;
		user-select: none;
		transition:
			background-color var(--motion-fast) var(--motion-easing),
			color var(--motion-fast) var(--motion-easing),
			border-color var(--motion-fast) var(--motion-easing);
	}

	.think-pill:hover {
		color: var(--color-foreground);
	}

	.think-pill.active {
		background: var(--accent-soft);
		color: var(--accent-text);
		border-color: var(--hairline-accent);
	}

	.think-pill:has(:focus-visible) {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
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
		padding: 0.5rem 0.75rem;
		border-radius: var(--radius-md);
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
		padding: 0 1.1rem;
		border-radius: var(--radius-md);
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
