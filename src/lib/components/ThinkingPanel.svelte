<script lang="ts">
	import { t } from '$lib/i18n/index.svelte';

	let {
		thinking,
		streaming,
		hedges
	}: { thinking: string; streaming: boolean; hedges?: string[] } = $props();

	function estimateTokens(text: string): number {
		return Math.round(text.length / 4);
	}

	function formatTokenCount(n: number): string {
		return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
	}

	let tokenLabel = $derived(formatTokenCount(estimateTokens(thinking)));
</script>

<!-- Uncontrolled <details> on purpose — no `open` binding, so a manual toggle
	 during streaming persists natively across content updates instead of
	 getting fought by reactivity. Collapsed by default. -->
<details class="thinking">
	<summary>
		{streaming
			? t('ThinkingPanel.streamingSummary', { tokens: tokenLabel })
			: t('ThinkingPanel.doneSummary', { tokens: tokenLabel })}
		{#if !streaming && hedges?.length}
			<span
				class="hedge-badge"
				title={t('ThinkingPanel.hedgeBadgeTitle', { hedges: hedges.join(', ') })}
			>{t('ThinkingPanel.hedgeBadge', { count: hedges.length })}</span
			>
		{/if}
	</summary>
	<pre>{thinking}</pre>
</details>

<style>
	.thinking {
		max-width: 70ch;
		margin-bottom: 0.4rem;
		font-size: 0.8rem;
		color: var(--color-muted-foreground);
	}

	.thinking summary {
		cursor: pointer;
	}

	.thinking pre {
		max-height: 40vh;
		overflow-y: auto;
		white-space: pre-wrap;
		background: none;
		padding: 0.4rem 0 0 0.5rem;
		font-family: var(--font-sans);
	}

	.hedge-badge {
		margin-left: 0.5rem;
		padding: 0.05rem 0.4rem;
		border-radius: 999px;
		font-size: 0.72rem;
		color: var(--warning);
		background: color-mix(in srgb, var(--warning) 20%, transparent);
	}
</style>
