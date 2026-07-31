<script lang="ts">
	import { onMount } from 'svelte';
	import type { LibraryNode } from '$lib/types';
	import { collectFilePaths, toggleNode, toIncludedPaths } from '$lib/sourceTree';
	import SourceTreeNode from './SourceTreeNode.svelte';
	import { Button } from '$lib/components/ui/button';

	/**
	 * Selection-focused sibling to LibraryTree (which stays the CRUD/navigation
	 * view at /settings/library) — same `/api/library/tree` data, different
	 * job: tri-state scoping for the active chat, not rename/delete/upload.
	 * Stateless by design: `includedPaths` is owned by the chat screen
	 * (+page.svelte), not here, so restoring a persisted selection on chat
	 * switch is just a prop change, never a second source of truth to
	 * reconcile (see Faz 9 Adım 6 plan).
	 */
	let {
		vaultId,
		includedPaths,
		onSelectionChange,
		onCounts,
		focusSignal = 0
	}: {
		vaultId: string;
		includedPaths?: string[];
		onSelectionChange: (paths: string[] | undefined) => void;
		onCounts?: (counts: { selected: number; total: number }) => void;
		focusSignal?: number;
	} = $props();

	let tree = $state<LibraryNode[]>([]);
	let loadError = $state('');
	let rootEl: HTMLDivElement | undefined;
	let flashing = $state(false);

	let allFiles = $derived(collectFilePaths(tree));
	let selected = $derived(includedPaths === undefined ? new Set(allFiles) : new Set(includedPaths));

	$effect(() => {
		onCounts?.({ selected: selected.size, total: allFiles.length });
	});

	// A ScopeIndicator click in the chat panel bumps this — scroll the tree
	// into view and briefly highlight it so the "where did that come from"
	// jump across panels doesn't feel like a no-op.
	$effect(() => {
		focusSignal;
		if (!rootEl) return;
		rootEl.scrollIntoView({ block: 'nearest' });
		flashing = true;
		const t = setTimeout(() => (flashing = false), 900);
		return () => clearTimeout(t);
	});

	onMount(async () => {
		try {
			const res = await fetch(`/api/library/tree?vault=${encodeURIComponent(vaultId)}`);
			if (!res.ok) throw new Error();
			tree = ((await res.json()) as { tree: LibraryNode[] }).tree;
		} catch {
			loadError = 'Kütüphane yüklenemedi.';
		}
	});

	function handleToggle(node: LibraryNode) {
		const next = toggleNode(node, selected);
		onSelectionChange(toIncludedPaths(next, allFiles));
	}

	function selectAll() {
		onSelectionChange(undefined);
	}

	function selectNone() {
		onSelectionChange([]);
	}
</script>

<div class="source-tree" class:flash={flashing} bind:this={rootEl}>
	<div class="header">
		<span class="title">Kaynaklar</span>
		<div class="quick-actions">
			<Button variant="ghost" size="sm" class="h-6 px-1.5 text-[0.7rem]" onclick={selectAll}>tümü</Button>
			<Button variant="ghost" size="sm" class="h-6 px-1.5 text-[0.7rem]" onclick={selectNone}>hiçbiri</Button>
		</div>
	</div>

	{#if loadError}
		<p class="error">{loadError}</p>
	{:else if tree.length === 0}
		<p class="empty">Kütüphane boş.</p>
	{:else}
		<div class="nodes">
			{#each tree as node (node.path)}
				<SourceTreeNode {node} {selected} ontoggle={handleToggle} />
			{/each}
		</div>
	{/if}

	<a class="manage-link" href="/settings/library">Kaynakları yönet →</a>
</div>

<style>
	.source-tree {
		display: flex;
		flex-direction: column;
		overflow-y: auto;
		flex: 1;
		min-height: 0;
		border-radius: 8px;
		transition: background-color 0.3s ease;
	}

	.source-tree.flash {
		background: color-mix(in srgb, var(--primary) 10%, transparent);
	}

	.header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 0.3rem;
	}

	.title {
		font-size: 0.75rem;
		font-weight: 600;
		color: var(--muted-foreground);
		text-transform: uppercase;
		letter-spacing: 0.02em;
	}

	.quick-actions {
		display: flex;
		gap: 0.15rem;
	}

	.nodes {
		flex: 1;
		min-height: 0;
	}

	.error {
		color: var(--destructive);
		font-size: 0.8rem;
	}

	.empty {
		color: var(--muted-foreground);
		font-size: 0.78rem;
		line-height: 1.4;
	}

	.manage-link {
		margin-top: 0.5rem;
		font-size: 0.72rem;
		color: var(--muted-foreground);
		text-decoration: none;
	}

	.manage-link:hover {
		color: var(--primary);
	}
</style>
