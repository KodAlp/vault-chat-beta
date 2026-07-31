<script lang="ts">
	import type { LibraryNode } from '$lib/types';
	import { nodeState } from '$lib/sourceTree';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import SourceTreeNode from './SourceTreeNode.svelte';

	let {
		node,
		selected,
		ontoggle
	}: { node: LibraryNode; selected: ReadonlySet<string>; ontoggle: (node: LibraryNode) => void } = $props();

	let expanded = $state(true);
	// Not named `state` — a local var with that exact name collides with the
	// $state rune (Svelte reads $state as "subscribe to store `state`").
	let triState = $derived(nodeState(node, selected));
</script>

<div class="node">
	<div
		class="row"
		onclick={() => node.type === 'folder' && (expanded = !expanded)}
		role="button"
		tabindex="0"
		onkeydown={(e) => e.key === 'Enter' && node.type === 'folder' && (expanded = !expanded)}
	>
		{#if node.type === 'folder'}
			<span class="caret" class:open={expanded}>▸</span>
		{:else}
			<span class="file-icon">📄</span>
		{/if}
		<Checkbox
			checked={triState === 'checked'}
			indeterminate={triState === 'indeterminate'}
			onclick={(e: Event) => e.stopPropagation()}
			onCheckedChange={() => ontoggle(node)}
		/>
		<span class="name">{node.name}</span>
	</div>
	{#if node.type === 'folder' && expanded && node.children}
		<div class="children">
			{#each node.children as child (child.path)}
				<SourceTreeNode node={child} {selected} {ontoggle} />
			{/each}
		</div>
	{/if}
</div>

<style>
	.node {
		font-size: 0.8rem;
	}

	.row {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		padding: 0.2rem 0.3rem;
		border-radius: 5px;
		cursor: pointer;
	}

	.row:hover {
		background: var(--bubble-assistant);
	}

	.caret {
		display: inline-block;
		transition: transform 0.1s ease;
		color: var(--muted-foreground);
		font-size: 0.7rem;
		width: 0.8rem;
	}

	.caret.open {
		transform: rotate(90deg);
	}

	.file-icon {
		font-size: 0.75rem;
		width: 0.8rem;
		text-align: center;
	}

	.name {
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.children {
		margin-left: 0.9rem;
		border-left: 1px solid var(--border);
		padding-left: 0.4rem;
	}
</style>
