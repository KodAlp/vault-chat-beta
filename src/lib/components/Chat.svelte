<script lang="ts">
	import type { ChatMessage, ChatRequestBody, StreamEvent } from '$lib/types';
	import Message from './Message.svelte';
	import ModelPicker from './ModelPicker.svelte';

	const FLUSH_INTERVAL_MS = 50;

	const STICK_THRESHOLD_PX = 80;

	let messages = $state<ChatMessage[]>([]);
	let input = $state('');
	let model = $state('qwen3:8b');
	let thinkMode = $state(false);
	let isStreaming = $state(false);
	let errorMessage = $state('');
	let isAtBottom = $state(true);
	let listEl: HTMLDivElement | undefined;
	let abortController: AbortController | undefined;

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
				model,
				think: thinkMode
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
					else if (event.type === 'done') assistantMessage.sources = event.sources;
					else if (event.type === 'error') errorMessage = event.message;
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

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			send();
		}
	}
</script>

<div class="chat">
	<header>
		<h1>Vault Chat</h1>
		<div class="header-controls">
			<label class="think-toggle" for="think-mode" title="Açıkken model önce akıl yürütür (yavaş ama daha derin), süreç sohbette görünür. Kapalıyken hızlı cevap verir.">
				<input id="think-mode" name="think-mode" type="checkbox" bind:checked={thinkMode} />
				Derin düşün
			</label>
			<ModelPicker bind:model />
		</div>
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
		height: 100dvh;
		max-width: 900px;
		margin: 0 auto;
	}

	header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0.75rem 1rem;
		border-bottom: 1px solid var(--border);
	}

	header h1 {
		font-size: 1.05rem;
		margin: 0;
	}

	.header-controls {
		display: flex;
		align-items: center;
		gap: 0.75rem;
	}

	.think-toggle {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		font-size: 0.85rem;
		color: var(--muted);
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
		background: var(--bg);
		color: var(--fg);
		font-size: 0.8rem;
		cursor: pointer;
		box-shadow: 0 2px 8px rgb(0 0 0 / 0.15);
	}

	.empty {
		color: var(--muted);
		text-align: center;
		margin-top: 2rem;
	}

	.error {
		color: var(--error);
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
		background: var(--bg);
		color: var(--fg);
		font-family: var(--font-sans);
		font-size: 0.95rem;
	}

	button {
		padding: 0 1.1rem;
		border-radius: 8px;
		border: none;
		background: var(--accent);
		color: var(--accent-fg);
		font-weight: 600;
		cursor: pointer;
	}

	button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	button.stop {
		background: var(--error);
		color: var(--bg);
	}
</style>
