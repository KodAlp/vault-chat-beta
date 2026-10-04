<!--
  ChatBubble.onerilen.svelte — src/lib/components/ChatBubble.svelte için önerilen sürüm.
  Değişen tek şey: `loading` sırasında üç nokta yerine ThinkingChick.

  Akış:
    loading true  → kuş "thinking" (kilidi bırakır, defteri açar, sayfa çevirir)
    loading false → kuş "done" (defteri kapatır, kilidi alır, ~500 ms)
                    → onexited → yanıt HTML'i görünür.
  Akış bu 500 ms boyunca da sürer; yanıt ilk göründüğünde zaten birkaç kelime gelmiş olur.

  Karar: kuş düşünme (reasoning) aşamasında da okur. Bunun için Message.svelte'deki
  `isWaitingForFirstToken`'dan `!message.thinking` kalkar — bkz. Message.svelte.patch.
-->
<script lang="ts">
	import { t } from '$lib/i18n/index.svelte';
	import ThinkingChick from './ThinkingChick.svelte';

	let {
		role,
		html,
		interrupted = false,
		loading = false
	}: { role: 'user' | 'assistant'; html: string; interrupted?: boolean; loading?: boolean } =
		$props();

	// Kuş görünür mü? loading başladığında açılır, çıkış animasyonu bitince kapanır.
	let chickVisible = $state(loading);
	let phase: 'idle' | 'thinking' | 'done' = $derived(loading ? 'thinking' : 'done');

	$effect(() => {
		if (loading) chickVisible = true;
	});
</script>

<div class="bubble markdown-body {role}" class:interrupted class:waiting={chickVisible && !interrupted}>
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
		max-width: var(--reading-measure);
		min-width: 0;
		padding: 0.6rem 0.9rem;
		border-radius: var(--radius-lg);
		line-height: 1.55;
		overflow-x: auto;
	}
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
		color: var(--label-secondary);
		font-style: italic;
	}

	/* Bekleme: balon dolgusuz, kuş sola yaslı. overflow görünür kalmalı —
	   kuşun kepi ve defteri viewBox dışına taşabiliyor. */
	.bubble.waiting {
		background: transparent;
		padding: 0;
		overflow: visible;
	}
	.chick-slot {
		width: 112px;
		margin: -6px 0 -10px -8px;
	}
</style>
