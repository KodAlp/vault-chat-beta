<script lang="ts">
	import { onMount } from 'svelte';
	import type { ChatMessage, ChatRequestBody, ProviderModelOption, StreamEvent } from '$lib/types';
	import Message from './Message.svelte';
	import { settings } from '$lib/settings.svelte';
	import { takePendingMessage } from '$lib/pending-message';

	let { chatId, vaultId }: { chatId: string; vaultId: string } = $props();

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
	let hasChatRow = $state(false);

	let activeModel = $derived(overrideModel ?? (thinkMode ? settings.reasoningModel : settings.fastModel));

	onMount(async () => {
		try {
			const res = await fetch('/api/providers/models');
			if (res.ok) modelOptions = (await res.json()) as ProviderModelOption[];
		} catch {
			// Header selector just shows the current model as a lone option — not fatal.
		}
	});

	async function onModelChange(id: string) {
		overrideModel = id;
		if (hasChatRow) {
			try {
				await fetch(`/api/chats/${chatId}`, {
					method: 'PATCH',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ model: id })
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
				think: thinkMode,
				chatId,
				titleModel: settings.defaultModel,
				vault: vaultId
			};
			const res = await fetch('/api/chat', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(requestBody),
				signal: abortController.signal
			});
			if (!res.ok || !res.body) throw new Error(`İstek başarısız (${res.status})`);

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
					else if (event.type === 'done') {
						assistantMessage.sources = event.sources;
						assistantMessage.narrowScope = event.narrowScope;
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
				errorMessage = err instanceof Error ? err.message : 'Bilinmeyen hata';
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
			if (!res.ok) throw new Error();
			const data = (await res.json()) as { chat: { model: string }; messages: ChatMessage[] };
			messages = data.messages;
			overrideModel = data.chat.model;
			hasChatRow = true;
			isAtBottom = true;
			scrollToBottom(true);
		} catch {
			errorMessage = 'Konuşma yüklenemedi';
		}
	}

	// Re-runs whenever the chatId prop changes (not just on first mount) — a
	// SvelteKit navigation between two /chat/[id] routes can reuse the same
	// component instance, so onMount alone would miss that.
	$effect(() => {
		const id = chatId;
		const pendingQuestion = takePendingMessage(id);
		if (pendingQuestion) {
			overrideModel = undefined;
			hasChatRow = false;
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
		<select
			class="model-select"
			title="Bu konuşma için model/sağlayıcı seçimi"
			value={activeModel}
			onchange={(e) => onModelChange(e.currentTarget.value)}
		>
			{#if !modelOptions.some((m) => m.id === activeModel)}
				<option value={activeModel}>{activeModel}</option>
			{/if}
			{#each modelOptions as m (m.providerId + '/' + m.id)}
				<option value={m.id}>{m.providerLabel} · {m.id}</option>
			{/each}
		</select>
		<label class="think-toggle" for="think-mode" title="Açıkken muhakeme modeli önce akıl yürütür (yavaş ama daha derin), süreç sohbette görünür. Kapalıyken hızlı model kullanılır.">
			<input id="think-mode" name="think-mode" type="checkbox" bind:checked={thinkMode} />
			Derin düşün
		</label>
	</header>

	<div class="messages-wrap">
		<div class="messages" bind:this={listEl} onscroll={handleScroll}>
			{#if messages.length === 0}
				<p class="empty">Kasandaki notlar hakkında bir soru sor.</p>
			{/if}
			{#each messages as message, i (message.id)}
				<Message {message} streaming={isStreaming && i === messages.length - 1} />
			{/each}
		</div>
		{#if isStreaming && !isAtBottom}
			<button class="scroll-to-bottom" onclick={() => scrollToBottom(true)}>
				↓ en sona in
			</button>
		{/if}
	</div>

	{#if errorMessage}
		<p class="error">{errorMessage}</p>
	{/if}

	<footer>
		<textarea
			id="chat-input"
			name="chat-input"
			bind:value={input}
			onkeydown={handleKeydown}
			placeholder="Soru yaz... (Enter: gönder, Shift+Enter: yeni satır)"
			disabled={isStreaming}
		></textarea>
		{#if isStreaming}
			<button class="stop" onclick={stop}>Durdur</button>
		{:else}
			<button onclick={send} disabled={!input.trim()}>Gönder</button>
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
		justify-content: flex-end;
		gap: 0.75rem;
		padding: 0.5rem 1rem;
		border-bottom: 1px solid var(--border);
	}

	.model-select {
		background: var(--background);
		color: var(--foreground);
		border: 1px solid var(--border);
		border-radius: 6px;
		padding: 0.3rem 0.5rem;
		font-size: 0.8rem;
		max-width: 220px;
	}

	.think-toggle {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		font-size: 0.85rem;
		color: var(--muted-foreground);
		cursor: pointer;
		user-select: none;
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
		position: absolute;
		bottom: 1rem;
		left: 50%;
		transform: translateX(-50%);
		padding: 0.4rem 0.9rem;
		border-radius: 999px;
		border: 1px solid var(--border);
		background: var(--background);
		color: var(--foreground);
		font-size: 0.8rem;
		cursor: pointer;
		box-shadow: 0 2px 8px rgb(0 0 0 / 0.15);
	}

	.empty {
		color: var(--muted-foreground);
		text-align: center;
		margin-top: 2rem;
	}

	.error {
		color: var(--destructive);
		padding: 0 1rem;
		font-size: 0.85rem;
	}

	footer {
		display: flex;
		gap: 0.5rem;
		padding: 0.75rem 1rem;
		border-top: 1px solid var(--border);
	}

	textarea {
		flex: 1;
		resize: none;
		min-height: 2.5rem;
		max-height: 10rem;
		padding: 0.5rem 0.75rem;
		border-radius: 8px;
		border: 1px solid var(--border);
		background: var(--background);
		color: var(--foreground);
		font-family: var(--font-sans);
		font-size: 0.95rem;
	}

	button {
		padding: 0 1.1rem;
		border-radius: 8px;
		border: none;
		background: var(--primary);
		color: var(--primary-foreground);
		font-weight: 600;
		cursor: pointer;
	}

	button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	button.stop {
		background: var(--destructive);
		color: var(--background);
	}
</style>
