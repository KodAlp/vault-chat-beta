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
		interrupted = false,
		loading = false
	}: { role: 'user' | 'assistant'; html: string; interrupted?: boolean; loading?: boolean } =
		$props();
</script>

<div class="bubble markdown-body {role}" class:interrupted>
	{#if interrupted}
		{t('ChatBubble.interrupted')}
	{:else if loading}
		<span class="thinking-dots" aria-hidden="true"><span></span><span></span><span></span></span>
		<span class="sr-only">{t('ChatBubble.waitingForResponse')}</span>
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

	/* First visible feedback between hitting send and the first token —
	   without this an empty assistant bubble gave zero indication anything
	   was happening, which read as the page having frozen. Same "one accent
	   dot breathing" idea as Chat.svelte's empty-state art, just three dots
	   staggered instead of one. */
	.thinking-dots {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		padding: 0.1rem 0;
	}

	.thinking-dots span {
		width: 0.4rem;
		height: 0.4rem;
		border-radius: 50%;
		background: var(--color-muted-foreground);
		animation: thinking-dot-pulse 1200ms ease-in-out infinite;
	}

	.thinking-dots span:nth-child(2) {
		animation-delay: 150ms;
	}

	.thinking-dots span:nth-child(3) {
		animation-delay: 300ms;
	}

	@keyframes thinking-dot-pulse {
		0%,
		80%,
		100% {
			transform: scale(0.7);
			opacity: 0.4;
		}
		40% {
			transform: scale(1);
			opacity: 1;
		}
	}

	/* Deliberate, narrow exception to app.css's universal reduced-motion
	   safety net (`*, *::before, *::after { animation-iteration-count: 1
	   !important; ... }`). That blanket rule is correct for decorative
	   motion (e.g. Chat.svelte's empty-state pulse) — it collapses to a
	   calm static state. But these dots are the ONLY signal that generation
	   is still running, not decoration; under that global rule they'd play
	   ~1ms once (staggered by animation-delay, so 2-3 quick flickers) and
	   then freeze solid for however long the model keeps streaming — i.e.
	   exactly the "looks frozen" problem this indicator exists to solve.
	   A class selector beats the universal `*` selector on specificity even
	   when both sides use !important, regardless of source order, so this
	   reliably wins. Motion is softened (smaller scale/opacity delta) rather
	   than left at full strength, so the user's preference still shapes the
	   result — just not all the way down to a frozen dot. */
	@media (prefers-reduced-motion: reduce) {
		.thinking-dots span {
			animation-duration: 1600ms !important;
			animation-iteration-count: infinite !important;
			animation-name: thinking-dot-pulse-reduced !important;
		}
	}

	@keyframes thinking-dot-pulse-reduced {
		0%,
		80%,
		100% {
			opacity: 0.4;
		}
		40% {
			opacity: 0.85;
		}
	}
</style>
