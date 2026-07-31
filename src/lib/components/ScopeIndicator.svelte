<script lang="ts">
	import { Badge } from '$lib/components/ui/badge';

	/** Faz 9 Adım 6 — lives in Chat.svelte's header so it sits next to the
	 * transcript it describes; clicking it jumps to SourceTree in the other
	 * panel (cross-panel, hence the callback rather than a direct link). */
	let {
		selected,
		total,
		onFocusTree
	}: { selected: number; total: number; onFocusTree: () => void } = $props();

	let scoped = $derived(total > 0 && selected < total);
</script>

<button type="button" class="indicator" onclick={onFocusTree} title="Kaynak ağacına git">
	{#if scoped}
		<Badge variant="secondary">{selected}/{total} kaynak aktif</Badge>
	{:else}
		<span class="all">tüm kaynaklar</span>
	{/if}
</button>

<style>
	.indicator {
		background: transparent;
		border: none;
		cursor: pointer;
		padding: 0;
	}

	.all {
		font-size: 0.72rem;
		color: var(--muted-foreground);
	}

	.indicator:hover .all {
		color: var(--primary);
	}
</style>
