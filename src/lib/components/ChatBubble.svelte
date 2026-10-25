<script lang="ts">
	import { untrack } from 'svelte';
	import { t } from '#lib/i18n/index.svelte.js';
	import ThinkingChick from './ThinkingChick.svelte';

	/** Assistant answers render as plain text on the canvas (.vc-msg-assistant);
	 * only the user's message is a bubble (.vc-msg-user). Needs `role` explicitly
	 * since this renders outside any `.message.user` ancestor.
	 *
	 * While `loading` (send -> first real answer token, including the model's
	 * reasoning phase) a ThinkingChick plays instead of the answer HTML. It keeps
	 * running until the 'done' exit finishes, then the HTML takes over. */
	let {
		role,
		html,
		interrupted = false,
		loading = false
	}: { role: 'user' | 'assistant'; html: string; interrupted?: boolean; loading?: boolean } =
		$props();

	// Starts visible only if this bubble mounts already loading (the streaming
	// one). Older messages mount with loading=false, so the chick never shows
	// on them. untrack: this is a deliberate one-time initial read.
	let chickVisible = $state(untrack(() => loading));
	let phase: 'idle' | 'thinking' | 'done' = $derived(loading ? 'thinking' : 'done');

	// loading flipping back to true (e.g. a `regenerate` event resets the content)
	// brings the chick back; its exit callback is the only thing that hides it.
	$effect(() => {
		if (loading) chickVisible = true;
	});

	// The chick's clock runs on requestAnimationFrame, which browsers throttle
	// or pause while the window is in the background/minimized — its ~1.5 s
	// exit could then hold the answer back indefinitely. Wall-clock cap: once
	// 'done', the answer shows after EXIT_CAP_MS whether or not the exit ended.
	const EXIT_CAP_MS = 2000;
	$effect(() => {
		if (loading || !chickVisible) return;
		const timer = setTimeout(() => (chickVisible = false), EXIT_CAP_MS);
		return () => clearTimeout(timer);
	});
</script>

<div
	class="bubble markdown-body {role === 'user' ? 'vc-msg-user' : 'vc-msg-assistant'}"
	class:interrupted
	class:waiting={chickVisible && !interrupted}
>
	{#if interrupted}
		{t('ChatBubble.interrupted')}
	{:else if chickVisible}
		<div class="chick-slot">
			<ThinkingChick
				{phase}
				label={t('ChatBubble.waitingForResponse')}
				onexited={() => (chickVisible = false)}
			/>
		</div>
	{:else}
		{@html html}
	{/if}
</div>

<style>
	.bubble {
		min-width: 0;
		/* KaTeX doesn't line-wrap (long sums, matrices, wide fractions) — contain
		   it with a horizontal scrollbar instead of letting it break out past
		   the column. */
		overflow-x: auto;
	}

	.bubble.vc-msg-assistant {
		max-width: 100%;
	}

	/* app.css's global `pre { overflow-x: auto }` would otherwise nest a
	   SECOND independent horizontal scrollbar inside this one for code
	   blocks. The bubble is the single scroll boundary for both KaTeX and
	   code; pre defers to it. */
	.bubble :global(pre) {
		overflow-x: visible;
		max-width: 100%;
	}

	.bubble :global(.katex-display) {
		margin: 0.5rem 0;
	}

	.bubble.interrupted {
		color: var(--label-secondary);
		font-style: italic;
	}

	/* Waiting: no fill, the chick sits left. overflow must stay visible — the
	   cap and notebook can extend past the SVG viewBox. */
	.bubble.waiting {
		overflow: visible;
	}

	.chick-slot {
		width: 112px;
		margin-block: -6px -10px;
		margin-inline: -8px 0;
	}
</style>
