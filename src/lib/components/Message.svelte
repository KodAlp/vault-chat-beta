<script lang="ts">
	import { renderMarkdown, stabilizeForStreaming } from '$lib/markdown';
	import type { ChatMessage } from '$lib/types';
	import SourceChip from './SourceChip.svelte';
	import ChatBubble from './ChatBubble.svelte';
	import FallbackNotice from './FallbackNotice.svelte';
	import ThinkingPanel from './ThinkingPanel.svelte';
	import { Button } from '$lib/components/ui/button';

	let {
		message,
		vaultId,
		streaming = false,
		onExpandScope
	}: {
		message: ChatMessage;
		vaultId: string;
		streaming?: boolean;
		onExpandScope?: () => void;
	} = $props();
	let html = $state('');

	// Stopped before any answer content arrived (e.g. during the thinking phase) —
	// an empty bubble reads as a bug, not "nothing to show here on purpose".
	let isEmptyInterrupted = $derived(
		message.role === 'assistant' && message.interrupted && !message.content
	);

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
	{#if message.role === 'assistant' && message.notices?.length}
		{#each message.notices as notice (notice)}
			<FallbackNotice message={notice} />
		{/each}
	{/if}
	{#if message.role === 'assistant' && message.thinking}
		<ThinkingPanel thinking={message.thinking} {streaming} />
	{/if}
	<!-- "polite" (not "assertive") so a screen reader announces streamed
	     content without interrupting whatever the user is already doing —
	     the 50ms flush loop in Chat.svelte previously updated this region
	     up to 20x/second with no aria-live at all, so assistive tech never
	     announced an answer arriving. -->
	<div aria-live={streaming ? 'polite' : 'off'} aria-atomic="false">
		<ChatBubble role={message.role} {html} interrupted={isEmptyInterrupted} />
	</div>
	{#if message.role === 'assistant' && message.sources?.length}
		<SourceChip sources={message.sources} {vaultId} />
	{/if}
	{#if message.role === 'assistant' && message.narrowScope && !streaming}
		<p class="narrow-scope">
			Seçili kaynaklarda bulunamadı.
			{#if onExpandScope}
				<Button variant="link" class="h-auto p-0 text-xs" onclick={onExpandScope}>Kapsamı genişlet?</Button>
			{/if}
		</p>
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

	.narrow-scope {
		margin-top: 0.4rem;
		font-size: 0.78rem;
		color: var(--color-muted-foreground);
	}
</style>
