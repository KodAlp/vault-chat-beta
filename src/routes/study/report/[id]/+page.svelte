<script lang="ts">
	import { onMount } from 'svelte';
	import { renderMarkdown } from '$lib/markdown';
	import { obsidianUri, libraryViewerUrl } from '$lib/sourceLink';
	import type { PageProps } from './$types';
	import type { ReportSectionView, ReportView } from '$lib/types';
	import ExternalLinkIcon from '@lucide/svelte/icons/external-link';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';

	let { data }: PageProps = $props();

	type Phase = 'loading' | 'ready' | 'error';

	let phase = $state<Phase>('loading');
	let report = $state<ReportView | null>(null);
	let renderedSections = $state<{ section: ReportSectionView; html: string }[]>([]);
	let errorMessage = $state('');

	// See study/quiz/[id]/+page.svelte's comment on quizQuery — an empty
	// `vault=` param is not the same as an absent one.
	let reportQuery = $derived(data.vaultId ? `?vault=${encodeURIComponent(data.vaultId)}` : '');

	onMount(async () => {
		try {
			const res = await fetch(`/api/study/reports/${data.reportId}${reportQuery}`);
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
	<title>{report?.title ?? 'Rapor'} — Vault Agent Toolkit</title>
</svelte:head>

<div class="report-screen">
	<a class="home-link" href="/"><ArrowLeftIcon size={14} aria-hidden="true" /> Ana sayfa</a>

	{#if phase === 'loading'}
		<p class="status">Yükleniyor...</p>
	{:else if phase === 'error'}
		<p class="status error" role="alert">{errorMessage}</p>
	{:else if phase === 'ready' && report}
		<h1>{report.title}</h1>
		<div class="sections">
			{#each renderedSections as r (r.section.id)}
				<section class="report-section">
					<h2>{r.section.heading}</h2>
					<div class="body markdown-body">{@html r.html}</div>
					<div class="citations">
						{#each r.section.source_paths as path (path)}
							<a class="source-link" href={libraryViewerUrl(path, data.vaultId ?? '')}>{path}</a>
							<a class="source-link" href={obsidianUri(path)} title="Obsidian'da aç" aria-label="Obsidian'da aç">
								<ExternalLinkIcon size={13} aria-hidden="true" />
							</a>
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
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		font-size: 0.875rem;
		color: var(--color-muted-foreground);
		text-decoration: none;
		margin-bottom: 1.5rem;
	}

	.home-link:hover {
		color: var(--color-primary);
	}

	.home-link:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}

	.status {
		color: var(--color-muted-foreground);
		text-align: center;
		margin-top: 3rem;
	}

	.status.error {
		color: var(--color-destructive);
	}

	h1 {
		font-family: var(--font-display);
		font-weight: 480;
		letter-spacing: -0.015em;
		font-size: 1.5rem;
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
		color: var(--color-muted-foreground);
		text-decoration: none;
		border: 1px solid var(--color-border);
		border-radius: 999px;
		padding: 0.2rem 0.65rem;
	}

	.source-link:hover {
		color: var(--color-primary);
		border-color: var(--color-primary);
	}
</style>
