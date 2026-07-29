<script lang="ts">
	import { renderMarkdown, stabilizeForStreaming } from '$lib/markdown';
	import type { ChatMessage } from '$lib/types';
	import SourceList from './SourceList.svelte';
	import ThinkingPanel from './ThinkingPanel.svelte';

	let { message, streaming = false }: { message: ChatMessage; streaming?: boolean } = $props();
	let html = $state('');

	// Streaming fires this effect many times per second; renderMarkdown() is async
	// (waits on shiki's one-time highlighter load), so calls can resolve out of
	// order. Only ever apply the result of the most recently *started* call.
	let latestCall = 0;
	$effect(() => {
		// Only in-flight messages get the truncation guard — a completed message
		// always renders its exact final text, never trimmed.
		const content = streaming ? stabilizeForStreaming(message.content) : message.content;
		const callId = ++latestCall;
		renderMarkdown(content)
			.then((rendered) => {
				if (callId === latestCall) html = rendered;
			})
			.catch((err) => {
				if (callId === latestCall) {
					console.error('renderMarkdown failed', err);
					html = content;
				}
			});
	});
</script>

<div class="message {message.role}">
	{#if message.role === 'assistant' && message.thinking}
		<ThinkingPanel thinking={message.thinking} {streaming} />
	{/if}
	<div class="bubble">
		{@html html}
	</div>
	{#if message.role === 'assistant' && message.sources?.length}
		<SourceList sources={message.sources} />
	{/if}
</div>

<style>
	.message {
		display: flex;
		margin: 0.75rem 0;
	}

	.message.user {
		justify-content: flex-end;
	}

	.message.assistant {
		justify-content: flex-start;
		flex-direction: column;
	}

	.bubble {
		max-width: 70ch;
		padding: 0.6rem 0.9rem;
		border-radius: 10px;
		line-height: 1.55;
	}

	.user .bubble {
		background: var(--bubble-user);
	}

	.assistant .bubble {
		background: var(--bubble-assistant);
	}

	.bubble :global(p:first-child) {
		margin-top: 0;
	}

	.bubble :global(p:last-child) {
		margin-bottom: 0;
	}
</style>
