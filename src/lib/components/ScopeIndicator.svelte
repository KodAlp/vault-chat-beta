<script lang="ts">
	import { Badge } from '$lib/components/ui/badge';
	import { t } from '$lib/i18n/index.svelte';

	/** Faz 9 Adım 6 — lives in Chat.svelte's header so it sits next to the
	 * transcript it describes; clicking it jumps to SourceTree in the other
	 * panel (cross-panel, hence the callback rather than a direct link). */
	let {
		selected,
		total,
		onFocusTree
	}: { selected: number; total: number; onFocusTree: () => void } = $props();

	let scoped = $derived(total > 0 && selected < total);
	// Zero selected sources is not a normal scope state — it's the one
	// selection that silently breaks the product's core promise (answers
	// grounded only in retrieved sources), so it earns a visually distinct
	// badge instead of blending in with any other partial-scope count.
	let zeroScope = $derived(total > 0 && selected === 0);
</script>

<button type="button" class="indicator" onclick={onFocusTree} title={t('ScopeIndicator.goToSourceTree')}>
	{#if zeroScope}
		<Badge variant="outline" class="border-[var(--warning)] text-[var(--warning)]">
			{t('ScopeIndicator.zeroScope', { total })}
		</Badge>
	{:else if scoped}
		<Badge variant="secondary">{t('ScopeIndicator.partialScope', { selected, total })}</Badge>
	{:else}
		<span class="all">{t('ScopeIndicator.allSources')}</span>
	{/if}
</button>

<style>
	.indicator {
		background: transparent;
		border: none;
		border-radius: var(--radius-sm);
		cursor: pointer;
		padding: 0;
	}

	.indicator:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}

	.all {
		font-size: 0.75rem;
		color: var(--color-muted-foreground);
	}

	.indicator:hover .all {
		color: var(--color-primary);
	}
</style>
