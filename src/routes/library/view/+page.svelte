<script lang="ts">
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import { renderMarkdown } from '$lib/markdown';

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
	<title>{filePath || 'Kaynak'} — Vault Chat</title>
</svelte:head>

<div class="viewer">
	<a class="home-link" href="/">← Ana sayfa</a>
	<p class="path">{filePath}</p>
	{#if error}
		<p class="error">{error}</p>
	{:else}
		<div class="content">{@html html}</div>
	{/if}
</div>

<style>
	.viewer {
		max-width: 760px;
		margin: 0 auto;
		padding: 1.5rem 1rem 3rem;
	}

	.home-link {
		display: inline-block;
		font-size: 0.9rem;
		text-decoration: none;
		margin-bottom: 1rem;
	}

	.path {
		font-size: 0.75rem;
		color: var(--muted-foreground);
		margin-bottom: 1.5rem;
		font-family: ui-monospace, 'SF Mono', Consolas, monospace;
	}

	.error {
		color: var(--destructive);
	}

	.content {
		line-height: 1.7;
	}
</style>
