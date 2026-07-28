<script lang="ts">
	import type { ChatMessage, ChatRequestBody, StreamEvent } from '$lib/types';
	import Message from './Message.svelte';
	import ModelPicker from './ModelPicker.svelte';

	const FLUSH_INTERVAL_MS = 50;

	let messages = $state<ChatMessage[]>([]);
	let input = $state('');
	let model = $state('qwen3:8b');
	let isStreaming = $state(false);
	let errorMessage = $state('');
	let listEl: HTMLDivElement | undefined;

	function scrollToBottom() {
		queueMicrotask(() => listEl?.scrollTo({ top: listEl.scrollHeight }));
	}

	async function send() {
		const question = input.trim();
		if (!question || isStreaming) return;

		errorMessage = '';
		input = '';
		messages.push({ role: 'user', content: question });
		const assistantMessage: ChatMessage = { role: 'assistant', content: '' };
		messages.push(assistantMessage);
		scrollToBottom();

		isStreaming = true;
		let raw = '';
		let flushed = '';
		const flush = () => {
			if (raw === flushed) return;
			flushed = raw;
			assistantMessage.content = raw;
			scrollToBottom();
		};
		const timer = setInterval(flush, FLUSH_INTERVAL_MS);

		try {
			const requestBody: ChatRequestBody = { messages: messages.slice(0, -1), model };
			const res = await fetch('/api/chat', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(requestBody)
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
					if (event.type === 'delta') raw += event.content;
					else if (event.type === 'done') assistantMessage.sources = event.sources;
					else if (event.type === 'error') errorMessage = event.message;
				}
			}
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : 'Bilinmeyen hata';
		} finally {
			clearInterval(timer);
			flush();
			isStreaming = false;
		}
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
		<ModelPicker bind:model />
	</header>

	<div class="messages" bind:this={listEl}>
		{#if messages.length === 0}
			<p class="empty">Kasandaki notlar hakkında bir soru sor.</p>
		{/if}
		{#each messages as message, i (i)}
			<Message {message} />
		{/each}
	</div>

	{#if errorMessage}
		<p class="error">{errorMessage}</p>
	{/if}

	<footer>
		<textarea
			bind:value={input}
			onkeydown={handleKeydown}
			placeholder="Soru yaz... (Enter: gönder, Shift+Enter: yeni satır)"
			disabled={isStreaming}
		></textarea>
		<button onclick={send} disabled={isStreaming || !input.trim()}>
			{isStreaming ? '...' : 'Gönder'}
		</button>
	</footer>
</div>

<style>
	.chat {
		display: flex;
		flex-direction: column;
		height: 100vh;
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

	.messages {
		flex: 1;
		overflow-y: auto;
		padding: 1rem;
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
</style>
