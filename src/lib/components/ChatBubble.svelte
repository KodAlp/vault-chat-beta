<script lang="ts">
	import { t } from '$lib/i18n/index.svelte';

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
		{t('ChatBubble.interrupted')}
	{:else}
		{@html html}
	{/if}
</div>

<style>
	.bubble {
		max-width: var(--reading-measure);
		min-width: 0;
		padding: 0.6rem 0.9rem;
		border-radius: var(--radius-lg);
		line-height: 1.55;
		/* KaTeX doesn't line-wrap (long sums, matrices, wide fractions) — contain
		   it with a horizontal scrollbar instead of letting it break out past
		   the bubble/chat column. */
		overflow-x: auto;
	}

	/* app.css's global `pre { overflow-x: auto }` would otherwise nest a
	   SECOND independent horizontal scrollbar inside this one for code
	   blocks — two competing scroll boundaries in one bubble, which reads as
	   "content partially hidden" rather than "scrollable". The bubble is the
	   single scroll boundary for both KaTeX and code; pre defers to it. */
	.bubble :global(pre) {
		overflow-x: visible;
		max-width: 100%;
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
		color: var(--color-muted-foreground);
		font-style: italic;
	}
</style>
