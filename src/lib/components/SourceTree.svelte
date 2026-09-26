<script lang="ts">
	import { onMount } from 'svelte';
	import type { LibraryNode, LibrarySettings } from '$lib/types';
	import { applyDisplayRules, collectFilePaths, toggleNode, toIncludedPaths, nodeMatchesFilter } from '$lib/sourceTree';
	import SourceTreeNode from './SourceTreeNode.svelte';
	import { Button } from '$lib/components/ui/button';
	import ArrowRightIcon from '@lucide/svelte/icons/arrow-right';
	import SearchIcon from '@lucide/svelte/icons/search';
	import * as AlertDialog from '$lib/components/ui/alert-dialog';
	import { t } from '$lib/i18n/index.svelte';

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
	// Display-only reshaping (vault-configurable hidden/flattened root
	// folders, see library.ts's DEFAULT_SETTINGS and applyDisplayRules'
	// doc comment) — selection/scoping below always operates on the raw
	// `tree`, never `displayTree`, since paths must stay exactly what
	// retrieve.ts and the generators expect regardless of how the tree is
	// drawn. Empty until settings load, same fail-open reasoning as
	// LibraryTree.svelte: an unreachable settings endpoint must not hide
	// content the user can otherwise select.
	let displayRules = $state<{ hiddenFolders: string[]; flattenFolders: string[] }>({
		hiddenFolders: [],
		flattenFolders: []
	});
	let loadError = $state('');
	let rootEl: HTMLDivElement | undefined;
	let flashing = $state(false);
	let filterQuery = $state('');
	let confirmingNone = $state(false);

	let displayTree = $derived(applyDisplayRules(tree, displayRules));
	// displayFiles, not collectFilePaths(tree): the raw tree still includes
	// hiddenFolders (raw/cards/frontier/wiki/_index) even though no node for
	// them ever reaches SourceTreeNode, so the user has no control that can
	// touch them. Deriving "select all" and the total/toggle baseline from
	// the raw tree meant every hidden file was silently pinned into
	// `selected` from the moment the tree loaded and could never be toggled
	// back out — a real scope ended up persisted as 205 paths (137 of them
	// unindexed raw/ files, 40 more force-excluded at retrieval) when the
	// user had picked exactly one visible folder. Basing everything here on
	// displayFiles instead means "selected"/"total" only ever count files
	// the user can actually see and that retrieval can actually return.
	let displayFiles = $derived(collectFilePaths(displayTree));
	let selected = $derived(includedPaths === undefined ? new Set(displayFiles) : new Set(includedPaths));
	let hasMatch = $derived(
		!filterQuery || displayTree.some((n) => nodeMatchesFilter(n, filterQuery))
	);

	$effect(() => {
		onCounts?.({ selected: selected.size, total: displayFiles.length });
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
			loadError = t('SourceTree.loadError');
		}
		try {
			const res = await fetch(`/api/library/settings?vault=${encodeURIComponent(vaultId)}`);
			if (res.ok) {
				const settings = (await res.json()) as LibrarySettings;
				displayRules = { hiddenFolders: settings.hiddenFolders, flattenFolders: settings.flattenFolders };
			}
		} catch {
			// displayRules just stays at its fail-open default (show everything)
		}
	});

	function handleToggle(node: LibraryNode) {
		const next = toggleNode(node, selected);
		onSelectionChange(toIncludedPaths(next, displayFiles));
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
		<span class="title">{t('SourceTree.title')}</span>
		<div class="quick-actions">
			<Button variant="ghost" size="sm" class="h-6 px-1.5 text-[0.7rem]" onclick={selectAll}>{t('SourceTree.selectAll')}</Button>
			<Button variant="ghost" size="sm" class="h-6 px-1.5 text-[0.7rem]" onclick={selectNone}>{t('SourceTree.selectNone')}</Button>
		</div>
	</div>

	{#if loadError}
		<p class="error" role="alert">{loadError}</p>
	{:else if tree.length === 0}
		<p class="empty">{t('SourceTree.empty')}</p>
	{:else}
		<label class="filter">
			<SearchIcon size={13} aria-hidden="true" />
			<input
				type="text"
				placeholder={t('SourceTree.searchPlaceholder')}
				bind:value={filterQuery}
				aria-label={t('SourceTree.searchPlaceholder')}
			/>
		</label>
		{#if hasMatch}
			<div class="nodes">
				{#each displayTree as node (node.path)}
					<SourceTreeNode {node} {selected} ontoggle={handleToggle} {filterQuery} />
				{/each}
			</div>
		{:else}
			<p class="empty">{t('SourceTree.noMatch', { query: filterQuery })}</p>
		{/if}
	{/if}

	<a class="manage-link" href="/settings/library">{t('SourceTree.manage')} <ArrowRightIcon size={13} aria-hidden="true" /></a>
</div>

<AlertDialog.Root bind:open={confirmingNone}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>{t('SourceTree.clearAllTitle')}</AlertDialog.Title>
			<AlertDialog.Description>
				{t('SourceTree.clearAllDescription')}
			</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>{t('Common.vazgec')}</AlertDialog.Cancel>
			<AlertDialog.Action onclick={confirmSelectNone}>{t('SourceTree.clearAllConfirm')}</AlertDialog.Action>
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
		transition: background-color var(--motion-base) var(--motion-easing);
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
