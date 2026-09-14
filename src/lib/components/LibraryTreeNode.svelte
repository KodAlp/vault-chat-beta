<script lang="ts">
	import { goto } from '$app/navigation';
	import type { LibraryNode } from '$lib/types';
	import LibraryTreeNode from './LibraryTreeNode.svelte';
	import * as AlertDialog from '$lib/components/ui/alert-dialog';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import FileTextIcon from '@lucide/svelte/icons/file-text';
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import { t } from '$lib/i18n/index.svelte';

	let { node, onchange }: { node: LibraryNode; onchange: () => void } = $props();

	let expanded = $state(false);
	let renaming = $state(false);
	let newName = $state('');
	let confirmingDelete = $state(false);

	function askRemove(e: MouseEvent) {
		e.stopPropagation();
		confirmingDelete = true;
	}

	async function confirmRemove() {
		confirmingDelete = false;
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

	// Space is the standard button-activation key alongside Enter — a
	// role="button" row that only wires Enter breaks keyboard-only users'
	// expectation that Space works too (the critique's Sam-persona finding).
	// preventDefault on Space stops the page from scrolling.
	function onRowKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter') openFile();
		else if (e.key === ' ') {
			e.preventDefault();
			openFile();
		}
	}
</script>

<div class="node">
	<div class="row" onclick={openFile} role="button" tabindex="0" onkeydown={onRowKeydown}>
		{#if node.type === 'folder'}
			<ChevronRightIcon class="caret {expanded ? 'open' : ''}" size={14} aria-hidden="true" />
		{:else}
			<FileTextIcon class="file-icon" size={13} aria-hidden="true" />
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
			<span class="badge" title={t('LibraryTreeNode.needsReview')}>!</span>
		{/if}
		<span class="row-actions">
			{#if node.type === 'file'}
				<button onclick={startRename} title={t('LibraryTreeNode.rename')} aria-label={t('LibraryTreeNode.rename')}>
					<PencilIcon size={13} aria-hidden="true" />
				</button>
			{/if}
			<button onclick={askRemove} title={t('Common.sil')} aria-label={t('Common.sil')}>
				<Trash2Icon size={13} aria-hidden="true" />
			</button>
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

<AlertDialog.Root bind:open={confirmingDelete}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>
				{node.type === 'folder'
					? t('LibraryTreeNode.deleteFolderTitle', { name: node.name })
					: t('LibraryTreeNode.deleteFileTitle', { name: node.name })}
			</AlertDialog.Title>
			<AlertDialog.Description>
				{#if node.type === 'folder'}
					{t('LibraryTreeNode.deleteFolderDescription')}
				{:else}
					{t('LibraryTreeNode.deleteFileDescription')}
				{/if}
			</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>{t('Common.vazgec')}</AlertDialog.Cancel>
			<AlertDialog.Action
				variant="destructive"
				onclick={(e) => {
					e.preventDefault();
					confirmRemove();
				}}
			>
				{t('Common.sil')}
			</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>

<style>
	.node {
		font-size: 0.8rem;
	}

	.row {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		padding: 0.2rem 0.3rem;
		border-radius: var(--radius-sm);
		cursor: pointer;
	}

	.row:hover {
		background: var(--bubble-assistant);
	}

	.row:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: -1px;
	}

	.row:hover .row-actions {
		visibility: visible;
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

	.name {
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.rename-input {
		flex: 1;
		font-size: 0.8rem;
		background: var(--color-background);
		color: var(--color-foreground);
		border: 1px solid var(--color-primary);
		border-radius: 4px;
		padding: 0.1rem 0.3rem;
	}

	.rename-input:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}

	.badge {
		flex-shrink: 0;
		background: color-mix(in srgb, var(--warning) 25%, transparent);
		color: var(--warning);
		font-size: 0.6875rem;
		font-weight: 700;
		border-radius: 50%;
		width: 1.1rem;
		height: 1.1rem;
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
		display: flex;
		align-items: center;
		background: transparent;
		border: none;
		color: var(--color-muted-foreground);
		cursor: pointer;
		padding: 0.15rem;
		border-radius: var(--radius-sm);
	}

	.row-actions button:hover {
		color: var(--color-primary);
	}

	.row-actions button:focus-visible {
		visibility: visible;
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}

	.children {
		margin-left: 0.9rem;
		border-left: 1px solid var(--color-border);
		padding-left: 0.4rem;
	}
</style>
