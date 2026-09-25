<script lang="ts">
	import { onMount } from 'svelte';
	import type { LibraryNode } from '$lib/types';
	import UploadDialog from './UploadDialog.svelte';
	import BatchUploadDialog from './BatchUploadDialog.svelte';
	import LibraryTreeNode from './LibraryTreeNode.svelte';
	import { t } from '$lib/i18n/index.svelte';

	let tree = $state<LibraryNode[]>([]);
	let loadError = $state('');

	async function refresh() {
		try {
			const res = await fetch('/api/library/tree');
			if (!res.ok) throw new Error();
			tree = ((await res.json()) as { tree: LibraryNode[] }).tree;
		} catch {
			loadError = t('LibraryTree.loadError');
		}
	}

	onMount(refresh);
</script>

<div class="library-tree">
	<UploadDialog onImported={refresh} />
	<BatchUploadDialog onImported={refresh} />

	{#if loadError}
		<p class="error" role="alert">{loadError}</p>
	{:else if tree.length === 0}
		<p class="empty">{t('LibraryTree.empty')}</p>
	{:else}
		{#each tree as node (node.path)}
			<LibraryTreeNode {node} onchange={refresh} />
		{/each}
	{/if}
</div>

<style>
	.library-tree {
		display: flex;
		flex-direction: column;
		overflow-y: auto;
		flex: 1;
		min-height: 0;
	}

	.error {
		color: var(--color-destructive);
		font-size: 0.8rem;
	}

	.empty {
		color: var(--color-muted-foreground);
		font-size: 0.78rem;
		line-height: 1.4;
	}
</style>
