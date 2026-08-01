<script lang="ts">
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import { renderMarkdown } from '$lib/markdown';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';

	let html = $state('');
	let error = $state('');
	let filePath = $derived(page.url.searchParams.get('path') ?? '');

	onMount(load);

	async function load() {
		error = '';
		html = '';
		if (!filePath) {
			error = 'path parametresi gerekli.';
			return;
		}
		try {
			const res = await fetch(`/api/library/file?path=${encodeURIComponent(filePath)}`);
			if (!res.ok) throw new Error();
			const data = (await res.json()) as { raw: string };
			// Strip the YAML frontmatter block before rendering — a plain
			// markdown renderer has no concept of frontmatter and would
			// otherwise show the raw "---\nkey: value\n---" block as text.
			const body = data.raw.replace(/^---\n[\s\S]*?\n---\n/, '');
			html = await renderMarkdown(body);
		} catch {
			error = 'Dosya yüklenemedi.';
		}
	}
</script>

<svelte:head>
	<title>{filePath || 'Kaynak'} — Vault Agent Toolkit</title>
</svelte:head>

<div class="viewer">
	<a class="home-link" href="/"><ArrowLeftIcon size={14} aria-hidden="true" /> Ana sayfa</a>
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
		font-size: 0.875rem;
		text-decoration: none;
		color: var(--color-muted-foreground);
		margin-bottom: 1rem;
	}

	.home-link:hover {
		color: var(--color-primary);
	}

	.home-link:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}

	.path {
		font-size: 0.75rem;
		color: var(--color-muted-foreground);
		margin-bottom: 1.5rem;
		font-family: var(--font-mono);
	}

	.error {
		display: flex;
		align-items: flex-start;
		gap: 0.6rem;
		padding: 0.9rem 1rem;
		border: 1px solid var(--hairline);
		border-radius: var(--radius-lg);
		background: var(--surface);
		color: var(--color-destructive);
	}

	.error p {
		margin: 0;
		color: var(--color-foreground);
	}

	.content {
		line-height: 1.7;
	}
</style>
