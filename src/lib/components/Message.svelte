<script lang="ts">
	import { renderMarkdown } from '$lib/markdown';
	import type { ChatMessage } from '$lib/types';
	import SourceList from './SourceList.svelte';

	let { message }: { message: ChatMessage } = $props();
	let html = $state('');

	$effect(() => {
		renderMarkdown(message.content).then((rendered) => {
			html = rendered;
		});
	});
</script>

<div class="message {message.role}">
	{#if message.role === 'assistant' && message.thinking}
		<details class="thinking" open>
			<summary>Düşünme süreci</summary>
			<pre>{message.thinking}</pre>
		</details>
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

	.thinking {
		max-width: 70ch;
		margin-bottom: 0.4rem;
		font-size: 0.8rem;
		color: var(--muted);
	}

	.thinking summary {
		cursor: pointer;
	}

	.thinking pre {
		max-height: 12rem;
		overflow-y: auto;
		white-space: pre-wrap;
		background: none;
		padding: 0.4rem 0 0 0.5rem;
		font-family: var(--font-sans);
	}
</style>
