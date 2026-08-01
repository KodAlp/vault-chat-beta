<script lang="ts">
	import { onMount } from 'svelte';
	import type { LibraryNode } from '$lib/types';
	import { collectFilePaths, toggleNode, toIncludedPaths, nodeMatchesFilter } from '$lib/sourceTree';
	import SourceTreeNode from './SourceTreeNode.svelte';
	import { Button } from '$lib/components/ui/button';
	import ArrowRightIcon from '@lucide/svelte/icons/arrow-right';
	import SearchIcon from '@lucide/svelte/icons/search';
	import * as AlertDialog from '$lib/components/ui/alert-dialog';

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
	let filterQuery = $state('');
	let confirmingNone = $state(false);

	let allFiles = $derived(collectFilePaths(tree));
	let selected = $derived(includedPaths === undefined ? new Set(allFiles) : new Set(includedPaths));
	let hasMatch = $derived(
		!filterQuery || tree.some((n) => nodeMatchesFilter(n, filterQuery))
	);

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
		// Zeroing all sources is a one-click way to silently break the
		// product's core promise (answers grounded only in retrieved
		// sources), so unlike selectAll it gets a confirm step rather than
		// applying immediately.
		confirmingNone = true;
	}

	function confirmSelectNone() {
		confirmingNone = false;
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
		<p class="error" role="alert">{loadError}</p>
	{:else if tree.length === 0}
		<p class="empty">Kütüphane boş.</p>
	{:else}
		<label class="filter">
			<SearchIcon size={13} aria-hidden="true" />
			<input
				type="text"
				placeholder="Kaynaklarda ara..."
				bind:value={filterQuery}
				aria-label="Kaynaklarda ara"
			/>
		</label>
		{#if hasMatch}
			<div class="nodes">
				{#each tree as node (node.path)}
					<SourceTreeNode {node} {selected} ontoggle={handleToggle} {filterQuery} />
				{/each}
			</div>
		{:else}
			<p class="empty">"{filterQuery}" ile eşleşen kaynak yok.</p>
		{/if}
	{/if}

	<a class="manage-link" href="/settings/library">Kaynakları yönet <ArrowRightIcon size={13} aria-hidden="true" /></a>
</div>

<AlertDialog.Root bind:open={confirmingNone}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>Tüm kaynaklar kaldırılsın mı?</AlertDialog.Title>
			<AlertDialog.Description>
				Hiçbir kaynak seçili olmadan sorulan sorulara model kaynak gösteremeyecek. İstediğin
				zaman "tümü"ne dönebilirsin.
			</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>Vazgeç</AlertDialog.Cancel>
			<AlertDialog.Action onclick={confirmSelectNone}>Kaldır</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>

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
		background: color-mix(in srgb, var(--color-primary) 10%, transparent);
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
		color: var(--color-muted-foreground);
		text-transform: uppercase;
		letter-spacing: 0.02em;
	}

	.quick-actions {
		display: flex;
		gap: 0.15rem;
	}

	.filter {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		padding: 0.3rem 0.55rem;
		margin-bottom: 0.4rem;
		color: var(--color-muted-foreground);
	}

	.filter:focus-within {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
		color: var(--color-foreground);
	}

	.filter input {
		flex: 1;
		min-width: 0;
		border: none;
		background: transparent;
		color: var(--color-foreground);
		font-size: 0.75rem;
		font-family: var(--font-sans);
	}

	.filter input:focus-visible {
		outline: none;
	}

	.filter input::placeholder {
		color: var(--color-muted-foreground);
	}

	.nodes {
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

	.manage-link {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		margin-top: 0.5rem;
		font-size: 0.75rem;
		color: var(--color-muted-foreground);
		text-decoration: none;
	}

	.manage-link:hover {
		color: var(--color-primary);
	}

	.manage-link:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}

	.manage-link:hover {
		color: var(--color-primary);
	}
</style>
