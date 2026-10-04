<script lang="ts">
	import { t } from '$lib/i18n/index.svelte';

	let { thinking, streaming }: { thinking: string; streaming: boolean } = $props();

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
<details class="vc-disclosure thinking">
	<summary>
		{streaming
			? t('ThinkingPanel.streamingSummary', { tokens: tokenLabel })
			: t('ThinkingPanel.doneSummary', { tokens: tokenLabel })}
	</summary>
	<div class="body"><pre>{thinking}</pre></div>
</details>

<style>
	.thinking {
		max-width: var(--reading-measure);
		margin-bottom: var(--space-2);
	}

	.thinking summary:focus-visible {
		outline: 2px solid var(--focus-ring);
		outline-offset: 2px;
	}

	.thinking pre {
		max-height: 40vh;
		overflow-y: auto;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		margin: 0;
		background: none;
		padding: 0;
		font: inherit;
	}
</style>
