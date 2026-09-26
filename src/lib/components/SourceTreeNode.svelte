<script lang="ts">
	import type { LibraryNode } from '$lib/types';
	import { nodeState, nodeMatchesFilter, isPathInsideFolder } from '$lib/sourceTree';
	import { sourceHighlight } from '$lib/source-highlight.svelte';
	import { prefersReducedMotion } from '$lib/motion';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import SourceTreeNode from './SourceTreeNode.svelte';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import FileTextIcon from '@lucide/svelte/icons/file-text';

	let {
		node,
		selected,
		ontoggle,
		filterQuery = ''
	}: {
		node: LibraryNode;
		selected: ReadonlySet<string>;
		ontoggle: (node: LibraryNode) => void;
		filterQuery?: string;
	} = $props();

	// Collapsed by default — a vault-sized tree (hundreds of files) fully
	// expanded on load is the exact "filling the whole side" weight problem;
	// the user drills down instead of scanning a wall of open folders.
	let expanded = $state(false);
	// Not named `state` — a local var with that exact name collides with the
	// $state rune (Svelte reads $state as "subscribe to store `state`").
	let triState = $derived(nodeState(node, selected));
	let visible = $derived(nodeMatchesFilter(node, filterQuery));
	// A live filter forces every surviving branch open — there'd be no way
	// to see a match three folders deep otherwise — but never writes back to
	// the stored `expanded`, so clearing the filter restores the pre-filter
	// collapse state exactly as it was.
	let effectiveExpanded = $derived(filterQuery ? true : expanded);

	// Task 6 — citation → source-tree focal moment. `lit`: this exact file
	// is the one currently hovered/focused in a chat citation chip.
	// `containsLit`: this folder is collapsed and the highlighted file is
	// somewhere underneath it — a quieter cue than `lit` since the folder
	// itself isn't the cited thing, only its container. Never applied to an
	// expanded folder: once open, the highlighted file's own row is already
	// visible and carries `lit` itself.
	let isLit = $derived(node.type === 'file' && sourceHighlight.path === node.path);
	let containsLit = $derived(
		node.type === 'folder' &&
			!effectiveExpanded &&
			sourceHighlight.path !== null &&
			isPathInsideFolder(sourceHighlight.path, node.path)
	);

	let rowEl: HTMLDivElement | undefined = $state();
	// Scrolls the row into view only on the transition INTO lit/contains-lit
	// — not on every re-render while it stays lit (e.g. a sibling toggling
	// its own checkbox shouldn't re-scroll this row back into place).
	let wasActive = false;
	$effect(() => {
		const active = isLit || containsLit;
		if (active && !wasActive && rowEl) {
			rowEl.scrollIntoView({ block: 'nearest', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
		}
		wasActive = active;
	});

	function onRowKeydown(e: KeyboardEvent) {
		if (node.type !== 'folder') return;
		if (e.key === 'Enter') expanded = !expanded;
		else if (e.key === ' ') {
			e.preventDefault();
			expanded = !expanded;
		}
	}
</script>

{#snippet rowContent()}
	{#if node.type === 'folder'}
		<ChevronRightIcon class="caret {effectiveExpanded ? 'open' : ''}" size={14} aria-hidden="true" />
	{:else}
		<FileTextIcon class="file-icon" size={13} aria-hidden="true" />
	{/if}
	<div class="checkbox-slot">
		<Checkbox
			checked={triState === 'checked'}
			indeterminate={triState === 'indeterminate'}
			onclick={(e: Event) => e.stopPropagation()}
			onCheckedChange={() => ontoggle(node)}
		/>
	</div>
	<span class="name" title={node.name}>{node.name}</span>
{/snippet}

{#if visible}
	<div class="node">
		{#if node.type === 'folder'}
			<div
				class="row folder"
				class:contains-lit={containsLit}
				bind:this={rowEl}
				onclick={() => (expanded = !expanded)}
				role="button"
				tabindex="0"
				onkeydown={onRowKeydown}
			>
				{@render rowContent()}
			</div>
		{:else}
			<div class="row" class:lit={isLit} bind:this={rowEl}>
				{@render rowContent()}
			</div>
		{/if}
		{#if node.type === 'folder' && effectiveExpanded && node.children}
			<div class="children">
				{#each node.children as child (child.path)}
					<SourceTreeNode node={child} {selected} {ontoggle} {filterQuery} />
				{/each}
			</div>
		{/if}
	</div>
{/if}

<style>
	.node {
		font-size: 0.8rem;
	}

	.row {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		padding: 0.2rem 0.3rem;
		border-radius: var(--radius-sm);
		transition:
			background-color var(--motion-fast) var(--motion-easing),
			box-shadow var(--motion-fast) var(--motion-easing);
	}

	.row.folder {
		cursor: pointer;
	}

	.row.folder:hover {
		background: var(--bubble-assistant);
	}

	/* Task 6 — citation → source-tree focal moment. `lit` is the exact file a
	   hovered/focused chat citation chip points at; `contains-lit` is the
	   quieter cue on a collapsed ancestor folder that the target lives
	   somewhere underneath it (never a solid green row — DESIGN.md's "one
	   bright thing per screen"). Both override the base .row transition-
	   duration to --motion-base so the highlight lights IN slower than it
	   fades OUT: the moment the class is removed, the element falls back to
	   .row's own --motion-fast duration for the exit. */
	.row.lit {
		background: var(--accent-soft);
		box-shadow: inset 2px 0 0 var(--hairline-accent);
		transition-duration: var(--motion-base);
	}

	.row.contains-lit {
		box-shadow: inset 2px 0 0 var(--hairline-accent);
		transition-duration: var(--motion-base);
	}

	.row:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: -1px;
	}

	:global(.caret) {
		flex-shrink: 0;
		transition: transform var(--motion-fast) var(--motion-easing);
		color: var(--color-muted-foreground);
	}

	:global(.caret.open) {
		transform: rotate(90deg);
	}

	:global(.file-icon) {
		flex-shrink: 0;
		color: var(--color-muted-foreground);
	}

	/* Checkbox's own invisible touch-target expansion (bits-ui's
	   after:-inset-x-3, ~12px each side) reaches further than .row's 0.4rem
	   gap alone provides, so its hit-area silently overlapped the file icon
	   to its left — a click meant for the icon/row landed on the checkbox
	   instead. This wrapper's own horizontal padding gives that expansion
	   room to exist without reaching the neighboring icon. */
	.checkbox-slot {
		padding-inline: 0.5rem;
		display: flex;
		align-items: center;
	}

	.name {
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.children {
		margin-left: 0.9rem;
		border-left: 1px solid var(--color-border);
		padding-left: 0.4rem;
	}
</style>
