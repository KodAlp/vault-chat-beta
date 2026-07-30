<script lang="ts">
	import { onMount } from 'svelte';
	import { renderMarkdown } from '$lib/markdown';
	import { obsidianUri, libraryViewerUrl } from '$lib/sourceLink';
	import type { PageProps } from './$types';
	import type { ReportSectionView, ReportView } from '$lib/types';

	let { data }: PageProps = $props();

	type Phase = 'loading' | 'ready' | 'error';

	let phase = $state<Phase>('loading');
	let report = $state<ReportView | null>(null);
	let renderedSections = $state<{ section: ReportSectionView; html: string }[]>([]);
	let errorMessage = $state('');

	onMount(async () => {
		try {
			const res = await fetch(`/api/study/reports/${data.reportId}`);
			if (!res.ok) throw new Error();
			const body = (await res.json()) as { report: ReportView; sections: ReportSectionView[] };
			report = body.report;
			if (body.sections.length === 0) {
				errorMessage = 'Bu raporda bölüm yok.';
				phase = 'error';
				return;
			}
			renderedSections = await Promise.all(
				body.sections.map(async (section) => ({
					section,
					html: await renderMarkdown(section.body_markdown)
				}))
			);
			phase = 'ready';
		} catch {
			errorMessage = 'Rapor yüklenemedi.';
			phase = 'error';
		}
	});
</script>

<svelte:head>
	<title>{report?.title ?? 'Rapor'} — Vault Chat</title>
</svelte:head>

<div class="report-screen">
	<a class="home-link" href="/">← Ana sayfa</a>

	{#if phase === 'loading'}
		<p class="status">Yükleniyor...</p>
	{:else if phase === 'error'}
		<p class="status error">{errorMessage}</p>
	{:else if phase === 'ready' && report}
		<h1>{report.title}</h1>
		<div class="sections">
			{#each renderedSections as r (r.section.id)}
				<section class="report-section">
					<h2>{r.section.heading}</h2>
					<div class="body markdown-body">{@html r.html}</div>
					<div class="citations">
						{#each r.section.source_paths as path (path)}
							<a class="source-link" href={obsidianUri(path)} title="Obsidian'da aç">{path}</a>
							<a class="source-link" href={libraryViewerUrl(path)} title="Kütüphanede görüntüle">⇱</a>
						{/each}
					</div>
				</section>
			{/each}
		</div>
	{/if}
</div>

<style>
	.report-screen {
		max-width: 720px;
		margin: 0 auto;
		padding: 1.5rem 1rem 3rem;
	}

	.home-link {
		display: inline-block;
		font-size: 0.9rem;
		text-decoration: none;
		margin-bottom: 1.5rem;
	}

	.status {
		color: var(--muted-foreground);
		text-align: center;
		margin-top: 3rem;
	}

	.status.error {
		color: var(--destructive);
	}

	h1 {
		font-size: 1.4rem;
		margin: 0 0 1.5rem;
	}

	.sections {
		display: flex;
		flex-direction: column;
		gap: 2rem;
	}

	.report-section h2 {
		font-size: 1.1rem;
		margin: 0 0 0.75rem;
	}

	.body {
		line-height: 1.7;
	}

	.citations {
		display: flex;
		gap: 0.4rem;
		flex-wrap: wrap;
		margin-top: 0.9rem;
	}

	.source-link {
		display: inline-block;
		font-size: 0.75rem;
		color: var(--muted-foreground);
		text-decoration: none;
		border: 1px solid var(--border);
		border-radius: 999px;
		padding: 0.2rem 0.65rem;
	}

	.source-link:hover {
		color: var(--primary);
		border-color: var(--primary);
	}
</style>
