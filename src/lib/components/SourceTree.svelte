<script lang="ts">
	import type { LibraryNode } from '$lib/types';
	import { nodeMatchesFilter, nodeHasSelected } from '$lib/sourceTree';
	import SourceTreeNode from './SourceTreeNode.svelte';
	import { t } from '$lib/i18n/index.svelte';

	/**
	 * Selection tree body (vc-tree) shown inside SourcesSheet. Purely
	 * presentational: SourcesSheet owns the fetched tree, the display rules
	 * and the `includedPaths` selection (which itself is owned by the chat
	 * screen, +page.svelte), so restoring a persisted selection on chat
	 * switch is just a prop change, never a second source of truth.
	 * `displayTree` is display-only reshaping (applyDisplayRules); selection
	 * always resolves to the exact paths retrieval expects.
	 */
	let {
		displayTree,
		selected,
		ontoggle,
		onOnly,
		filterQuery = '',
		selectedOnly = false,
		loadError = ''
	}: {
		displayTree: LibraryNode[];
		selected: ReadonlySet<string>;
		ontoggle: (node: LibraryNode) => void;
		onOnly?: (node: LibraryNode) => void;
		filterQuery?: string;
		selectedOnly?: boolean;
		loadError?: string;
	} = $props();

	let hasMatch = $derived(
		displayTree.some(
			(n) => nodeMatchesFilter(n, filterQuery) && (!selectedOnly || nodeHasSelected(n, selected))
		)
	);
</script>

{#if loadError}
	<p class="note error" role="alert">{loadError}</p>
{:else if displayTree.length === 0}
	<p class="note">{t('SourceTree.empty')}</p>
{:else if !hasMatch}
	<p class="note">
		{filterQuery ? t('SourceTree.noMatch', { query: filterQuery }) : t('SourcesSheet.noSelectedMatch')}
	</p>
{:else}
	<ul class="vc-tree" role="tree" aria-label={t('SourcesSheet.treeLabel')} aria-multiselectable="true">
		{#each displayTree as node (node.path)}
			<SourceTreeNode {node} {selected} {ontoggle} {onOnly} {filterQuery} {selectedOnly} />
		{/each}
	</ul>
{/if}

<style>
	.note {
		margin: 0;
		padding: var(--space-4) var(--space-5);
		font: 400 14px/20px var(--font-sans);
		color: var(--label-secondary);
	}

	.note.error {
		color: var(--danger);
	}
</style>
