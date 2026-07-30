<script lang="ts">
	import { goto } from '$app/navigation';
	import type { LibraryNode } from '$lib/types';
	import LibraryTreeNode from './LibraryTreeNode.svelte';

	let { node, onchange }: { node: LibraryNode; onchange: () => void } = $props();

	let expanded = $state(false);
	let renaming = $state(false);
	let newName = $state('');

	async function remove(e: MouseEvent) {
		e.stopPropagation();
		const label = node.type === 'folder' ? `"${node.name}" klasörü ve içindekiler` : `"${node.name}"`;
		if (!confirm(`${label} silinsin mi?`)) return;
		const res = await fetch('/api/library/file', {
			method: 'DELETE',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ path: node.path })
		});
		if (res.ok) onchange();
	}

	function startRename(e: MouseEvent) {
		e.stopPropagation();
		newName = node.name;
		renaming = true;
	}

	async function submitRename() {
		// Idempotency guard: removing the input from the DOM (below) fires a
		// native blur event, which re-invokes this same handler a second time
		// (onblur is still wired) with now-stale state — without this guard it
		// fires a redundant second rename request for a file that's already
		// been renamed by the first call.
		if (!renaming) return;
		renaming = false;
		if (!newName.trim() || newName === node.name) return;
		const parentPath = node.path.split('/').slice(0, -1).join('/');
		const newPath = parentPath ? `${parentPath}/${newName.trim()}` : newName.trim();
		const res = await fetch('/api/library/rename', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ oldPath: node.path, newPath })
		});
		if (res.ok) onchange();
	}

	function openFile() {
		if (node.type === 'file') goto(`/library/view?path=${encodeURIComponent(node.path)}`);
		else expanded = !expanded;
	}
</script>

<div class="node">
	<div class="row" onclick={openFile} role="button" tabindex="0" onkeydown={(e) => e.key === 'Enter' && openFile()}>
		{#if node.type === 'folder'}
			<span class="caret" class:open={expanded}>▸</span>
		{:else}
			<span class="file-icon">📄</span>
		{/if}
		{#if renaming}
			<input
				class="rename-input"
				bind:value={newName}
				onclick={(e) => e.stopPropagation()}
				onkeydown={(e) => {
					// stopPropagation is required, not cosmetic: the parent .row
					// has its own onkeydown (Enter -> openFile, for keyboard
					// accessibility) — without this, pressing Enter to confirm a
					// rename also bubbles up and navigates to the file viewer.
					e.stopPropagation();
					if (e.key === 'Enter') submitRename();
				}}
				onblur={submitRename}
			/>
		{:else}
			<span class="name">{node.name}</span>
		{/if}
		{#if node.needsReview}
			<span class="badge" title="Gözden geçirme gerekiyor">!</span>
		{/if}
		<span class="row-actions">
			{#if node.type === 'file'}
				<button onclick={startRename} title="Yeniden adlandır">✎</button>
			{/if}
			<button onclick={remove} title="Sil">🗑</button>
		</span>
	</div>
	{#if node.type === 'folder' && expanded && node.children}
		<div class="children">
			{#each node.children as child (child.path)}
				<LibraryTreeNode node={child} {onchange} />
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
		gap: 0.35rem;
		padding: 0.2rem 0.3rem;
		border-radius: 5px;
		cursor: pointer;
	}

	.row:hover {
		background: var(--bubble-assistant);
	}

	.row:hover .row-actions {
		visibility: visible;
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
	}

	.name {
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.rename-input {
		flex: 1;
		font-size: 0.8rem;
		background: var(--background);
		color: var(--foreground);
		border: 1px solid var(--primary);
		border-radius: 4px;
		padding: 0.1rem 0.3rem;
	}

	.badge {
		flex-shrink: 0;
		background: color-mix(in srgb, orange 25%, transparent);
		color: #b8860b;
		font-size: 0.65rem;
		font-weight: 700;
		border-radius: 50%;
		width: 1rem;
		height: 1rem;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.row-actions {
		visibility: hidden;
		display: flex;
		gap: 0.2rem;
		flex-shrink: 0;
	}

	.row-actions button {
		background: transparent;
		border: none;
		color: var(--muted-foreground);
		cursor: pointer;
		font-size: 0.75rem;
		padding: 0.1rem 0.2rem;
	}

	.row-actions button:hover {
		color: var(--primary);
	}

	.children {
		margin-left: 0.9rem;
		border-left: 1px solid var(--border);
		padding-left: 0.4rem;
	}
</style>
