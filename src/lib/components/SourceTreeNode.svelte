<script lang="ts">
	import type { LibraryNode } from '$lib/types';
	import {
		nodeState,
		nodeMatchesFilter,
		nodeHasSelected,
		countFiles,
		countSelected,
		isPathInsideFolder
	} from '$lib/sourceTree';
	import { sourceHighlight } from '$lib/source-highlight.svelte';
	import { prefersReducedMotion } from '$lib/motion';
	import { t } from '$lib/i18n/index.svelte';
	import SourceTreeNode from './SourceTreeNode.svelte';

	let {
		node,
		selected,
		ontoggle,
		onOnly,
		filterQuery = '',
		selectedOnly = false,
		level = 0
	}: {
		node: LibraryNode;
		selected: ReadonlySet<string>;
		ontoggle: (node: LibraryNode) => void;
		/** "Yalnızca" — replace the whole selection with just this node. */
		onOnly?: (node: LibraryNode) => void;
		filterQuery?: string;
		/** "Seçililer" view: hide everything with no selected file under it. */
		selectedOnly?: boolean;
		level?: number;
	} = $props();

	// Collapsed by default — a vault-sized tree (hundreds of files) fully
	// expanded on load is the exact "filling the whole side" weight problem;
	// the user drills down instead of scanning a wall of open folders.
	let expanded = $state(false);
	// Not named `state` — a local var with that exact name collides with the
	// $state rune (Svelte reads $state as "subscribe to store `state`").
	let triState = $derived(nodeState(node, selected));
	let visible = $derived(
		nodeMatchesFilter(node, filterQuery) && (!selectedOnly || nodeHasSelected(node, selected))
	);
	// A live filter forces every surviving branch open — there'd be no way
	// to see a match three folders deep otherwise — but never writes back to
	// the stored `expanded`, so clearing the filter restores the pre-filter
	// collapse state exactly as it was.
	let effectiveExpanded = $derived(filterQuery ? true : expanded);
	let total = $derived(countFiles(node));
	let selectedCount = $derived(countSelected(node, selected));

	// Citation -> source-tree focal moment. `lit`: this exact file is the one
	// currently hovered/focused in a chat citation chip. `containsLit`: this
	// folder is collapsed and the highlighted file is somewhere underneath it
	// — a quieter cue than `lit` since the folder itself isn't the cited
	// thing, only its container. Never applied to an expanded folder.
	let isLit = $derived(node.type === 'file' && sourceHighlight.path === node.path);
	let containsLit = $derived(
		node.type === 'folder' &&
			!effectiveExpanded &&
			sourceHighlight.path !== null &&
			isPathInsideFolder(sourceHighlight.path, node.path)
	);

	let rowEl: HTMLDivElement | undefined = $state();
	// Scrolls the row into view only on the transition INTO lit/contains-lit
	// — not on every re-render while it stays lit.
	let wasActive = false;
	$effect(() => {
		const active = isLit || containsLit;
		if (active && !wasActive && rowEl) {
			rowEl.scrollIntoView({ block: 'nearest', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
		}
		wasActive = active;
	});

	function onRowClick(e: MouseEvent) {
		if (node.type !== 'folder') return;
		// Clicks on the inner buttons (disclosure, checkbox, "Yalnızca") do
		// their own thing.
		if ((e.target as HTMLElement).closest('button')) return;
		expanded = !expanded;
	}
</script>

{#if visible}
	<li
		role="treeitem"
		aria-selected="false"
		aria-level={level + 1}
		aria-expanded={node.type === 'folder' ? effectiveExpanded : undefined}
	>
		<!-- Keyboard users operate the inner buttons (disclosure / checkbox /
		     "Yalnızca"); the row click is only a mouse convenience. -->
		<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
		<div
			class="vc-trow {node.type === 'file' ? 'file' : ''}"
			class:lit={isLit}
			class:contains-lit={containsLit}
			class:clickable={node.type === 'folder'}
			style="--lvl:{level}"
			bind:this={rowEl}
			onclick={onRowClick}
		>
			<button
				type="button"
				class="vc-disc"
				class:leaf={node.type === 'file'}
				aria-expanded={node.type === 'folder' ? effectiveExpanded : undefined}
				aria-label={t('SourcesSheet.toggleFolder')}
				disabled={node.type === 'file' || !!filterQuery}
				onclick={() => (expanded = !expanded)}
			></button>
			<button
				type="button"
				class="vc-cb"
				role="checkbox"
				aria-checked={triState === 'checked' ? 'true' : triState === 'indeterminate' ? 'mixed' : 'false'}
				aria-label={node.name}
				onclick={() => ontoggle(node)}
			></button>
			<span class="vc-tname" title={node.name}>{node.name}</span>
			<span class="vc-tmeta">
				{#if onOnly}
					<button
						type="button"
						class="vc-only"
						title={t('SourcesSheet.onlyTitle', { name: node.name })}
						aria-label={t('SourcesSheet.onlyTitle', { name: node.name })}
						onclick={() => onOnly(node)}
					>{t('SourcesSheet.only')}</button>
				{/if}
				{#if node.type === 'folder'}
					{selectedCount === total ? total : selectedCount + '/' + total}
				{:else if node.needsReview}
					<i class="vc-idx stale" title={t('SourcesSheet.noReview')}></i>
				{/if}
			</span>
		</div>
		{#if node.type === 'folder' && effectiveExpanded && node.children}
			<ul role="group">
				{#each node.children as child (child.path)}
					<SourceTreeNode
						node={child}
						{selected}
						{ontoggle}
						{onOnly}
						{filterQuery}
						{selectedOnly}
						level={level + 1}
					/>
				{/each}
			</ul>
		{/if}
	</li>
{/if}

<style>
	.vc-trow {
		transition:
			background-color var(--duration-fast),
			box-shadow var(--duration-fast);
	}

	.vc-trow.clickable {
		cursor: pointer;
	}

	.vc-disc:disabled:not(.leaf) {
		opacity: 0.4;
		cursor: default;
	}

	/* Citation focal moment: lit = the exact cited file, contains-lit = the
	   quieter cue on a collapsed ancestor. Lights IN slower than it fades OUT. */
	.vc-trow.lit {
		background: var(--accent-soft);
		box-shadow: inset 2px 0 0 var(--accent-text);
		transition-duration: var(--duration-base);
	}

	.vc-trow.contains-lit {
		box-shadow: inset 2px 0 0 var(--accent-text);
		transition-duration: var(--duration-base);
	}

	@media (prefers-reduced-motion: reduce) {
		.vc-trow {
			transition: none;
		}
	}
</style>
