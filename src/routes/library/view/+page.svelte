<script lang="ts">
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import { renderMarkdown } from '$lib/markdown';
	import { resolveBackHref } from '$lib/back-link';
	import { t } from '$lib/i18n/index.svelte';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';

	let html = $state('');
	let error = $state('');
	let filePath = $derived(page.url.searchParams.get('path') ?? '');
	let vaultId = $derived(page.url.searchParams.get('vault') ?? '');
	// See back-link.ts — sourceLink.ts's libraryViewerUrl attaches `from`
	// whenever a study page or SourceChip links here, so this returns to
	// the exact artifact the citation was clicked from, not a hardcoded
	// home link.
	let backHref = $derived(resolveBackHref(page.url.searchParams.get('from'), vaultId ? `/vault/${vaultId}` : '/'));

	onMount(load);

	async function load() {
		error = '';
		html = '';
		if (!filePath) {
			error = t('LibraryViewPage.missingPath');
			return;
		}
		try {
			const params = new URLSearchParams({ path: filePath });
			if (vaultId) params.set('vault', vaultId);
			const res = await fetch(`/api/library/file?${params.toString()}`);
			if (!res.ok) throw new Error();
			const data = (await res.json()) as { raw: string };
			// Strip the YAML frontmatter block before rendering — a plain
			// markdown renderer has no concept of frontmatter and would
			// otherwise show the raw "---\nkey: value\n---" block as text.
			const body = data.raw.replace(/^---\n[\s\S]*?\n---\n/, '');
			html = await renderMarkdown(body, vaultId ? { vaultId, currentPath: filePath } : undefined);
		} catch {
			error = t('LibraryViewPage.loadFailed');
		}
	}
</script>

<svelte:head>
	<title>{filePath || t('LibraryViewPage.fallbackTitle')} — Vault Agent Toolkit</title>
</svelte:head>

<div class="viewer">
	<a class="home-link" href={backHref}><ArrowLeftIcon size={14} aria-hidden="true" /> {t('Common.geriDon')}</a>
	<p class="path">{filePath}</p>
	{#if error}
		<div class="error">
			<TriangleAlertIcon size={16} aria-hidden="true" />
			<p>{error}</p>
		</div>
	{:else}
		<div class="content markdown-body">{@html html}</div>
	{/if}
</div>

<style>
	.viewer {
		max-width: 760px;
		margin: 0 auto;
		padding: 1.5rem 1rem 3rem;
	}

	.home-link {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		font: var(--text-subheadline);
		text-decoration: none;
		color: var(--label-secondary);
		margin-bottom: 1rem;
	}

	.home-link:hover {
		color: var(--label);
	}

	.home-link:focus-visible {
		outline: 2px solid var(--focus-ring);
		outline-offset: 2px;
	}

	.path {
		font: var(--text-caption-1);
		color: var(--label-secondary);
		margin-bottom: 1.5rem;
		font-family: var(--font-mono);
	}

	.error {
		display: flex;
		align-items: flex-start;
		gap: 0.6rem;
		padding: 0.9rem 1rem;
		box-shadow: inset 0 0 0 1px var(--separator);
		border-radius: var(--radius-lg);
		background: var(--bg-elevated);
		color: var(--danger);
	}

	.error p {
		margin: 0;
		color: var(--color-foreground);
	}

	.content {
		line-height: 1.7;
	}
</style>
