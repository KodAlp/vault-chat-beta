<script lang="ts">
	/** Extracted from Message.svelte during Faz 9 Adım 6's SourceChip/
	 * FallbackNotice work — Message.svelte was being edited anyway, so
	 * splitting out the bubble markup was zero-extra-cost. Needs `role`
	 * explicitly (unlike before, where the background came from a
	 * `.message.user .bubble` descendant selector) since this no longer
	 * renders inside that parent. */
	let {
		role,
		html,
		interrupted = false
	}: { role: 'user' | 'assistant'; html: string; interrupted?: boolean } = $props();
</script>

<div class="bubble markdown-body {role}" class:interrupted>
	{#if interrupted}
		Durduruldu
	{:else}
		{@html html}
	{/if}
</div>

<style>
	.bubble {
		max-width: 70ch;
		min-width: 0;
		padding: 0.6rem 0.9rem;
		border-radius: 10px;
		line-height: 1.55;
		/* KaTeX doesn't line-wrap (long sums, matrices, wide fractions) — contain
		   it with a horizontal scrollbar instead of letting it break out past
		   the bubble/chat column. */
		overflow-x: auto;
	}

	.bubble :global(.katex-display) {
		margin: 0.5rem 0;
	}

	.bubble.user {
		background: var(--bubble-user);
	}

	.bubble.assistant {
		background: var(--bubble-assistant);
	}

	.bubble.interrupted {
		color: var(--muted-foreground);
		font-style: italic;
	}
</style>
