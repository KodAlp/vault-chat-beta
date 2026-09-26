<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { renderMarkdown } from '$lib/markdown';
	import { libraryViewerUrl } from '$lib/sourceLink';
	import { resolveBackHref } from '$lib/back-link';
	import { t } from '$lib/i18n/index.svelte';
	import { readResponseError, localizeError } from '$lib/server-error';
	import type { PageProps } from './$types';
	import type { ReportSectionView, ReportView } from '$lib/types';
	import ExternalLinkIcon from '@lucide/svelte/icons/external-link';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';

	let { data }: PageProps = $props();

	// See back-link.ts — falls back to the vault's chat list, not "/", when
	// this page was opened directly (no `from`, e.g. a bookmark).
	let backHref = $derived(
		resolveBackHref(page.url.searchParams.get('from'), data.vaultId ? `/vault/${data.vaultId}` : '/')
	);
	let here = $derived(page.url.pathname + page.url.search);

	type Phase = 'loading' | 'ready' | 'error';

	let phase = $state<Phase>('loading');
	let notFound = $state(false);
	let report = $state<ReportView | null>(null);
	let renderedSections = $state<{ section: ReportSectionView; html: string }[]>([]);
	let errorMessage = $state('');

	// See study/quiz/[id]/+page.svelte's comment on quizQuery — an empty
	// `vault=` param is not the same as an absent one.
	let reportQuery = $derived(data.vaultId ? `?vault=${encodeURIComponent(data.vaultId)}` : '');

	async function load() {
		phase = 'loading';
		notFound = false;
		errorMessage = '';
		try {
			const res = await fetch(`/api/study/reports/${data.reportId}${reportQuery}`);
			if (!res.ok) {
				if (res.status === 404) {
					notFound = true;
				} else {
					errorMessage = await readResponseError(res);
				}
				phase = 'error';
				return;
			}
			const body = (await res.json()) as { report: ReportView; sections: ReportSectionView[] };
			report = body.report;
			if (body.sections.length === 0) {
				errorMessage = t('ReportStudyPage.noSections');
				phase = 'error';
				return;
			}
			renderedSections = await Promise.all(
				body.sections.map(async (section) => ({
					// Deduped here too, not only in generate-report.ts: reports
					// written before that fix are still in study.db with the same
					// path listed twice, and rendering the identical citation link
					// twice is just noise. The keyed-each below stays index-based
					// regardless — that is the crash guard, this is the cosmetics.
					section: { ...section, source_paths: [...new Set(section.source_paths)] },
					html: await renderMarkdown(section.body_markdown)
				}))
			);
			phase = 'ready';
		} catch (err) {
			errorMessage = localizeError({ message: err instanceof Error ? err.message : undefined });
			phase = 'error';
		}
	}

	onMount(load);
</script>

<svelte:head>
	<title>{report?.title ?? t('ReportStudyPage.defaultTitle')} — Vault Agent Toolkit</title>
</svelte:head>

<div class="report-screen">
	<a class="home-link" href={backHref}><ArrowLeftIcon size={14} aria-hidden="true" /> {t('Common.geriDon')}</a>

	{#if phase === 'loading'}
		<p class="status">{t('Common.yukleniyor')}</p>
	{:else if phase === 'error'}
		{#if notFound}
			<p class="status error" role="alert">{t('ReportStudyPage.notFoundTitle')}</p>
			<p class="status">{t('ReportStudyPage.notFoundBody')}</p>
		{:else}
			<p class="status error" role="alert">{errorMessage}</p>
			<div class="retry-row">
				<button type="button" class="retry-btn" onclick={load}>{t('Common.yenidenDene')}</button>
			</div>
		{/if}
	{:else if phase === 'ready' && report}
		<!-- Boundary, not bare markup: phase='ready' is assigned before this
		     subtree has rendered even once, so a render-time throw here used to
		     abort the update with the DOM still showing "Yükleniyor..." — a
		     permanent fake loading state with nothing in the UI to explain it.
		     That is exactly what a duplicate source_paths entry did (Svelte's
		     each_key_duplicate; fixed at the source in generate-report.ts too).
		     Keep both: the data fix stops today's cause, this stops the whole
		     class from ever presenting as a hang again. -->
		<svelte:boundary>
			<h1>{report.title}</h1>
			<div class="sections">
				{#each renderedSections as r (r.section.id)}
					<section class="report-section">
						<h2>{r.section.heading}</h2>
						<div class="body markdown-body">{@html r.html}</div>
						<div class="citations">
							<!-- Keyed by path+index, not path alone: a section can
							     legitimately cite the same file twice (see
							     generate-report.ts's dedupe comment). -->
							{#each r.section.source_paths as path, i (path + '#' + i)}
								<a class="source-link" href={libraryViewerUrl(path, data.vaultId ?? '', here)}>{path}</a>
								<a class="source-link" href={libraryViewerUrl(path, data.vaultId ?? '', here)} title={t('Common.kaynagiAc')} aria-label={t('Common.kaynagiAc')}>
									<ExternalLinkIcon size={13} aria-hidden="true" />
								</a>
							{/each}
						</div>
					</section>
				{/each}
			</div>
			{#snippet failed(error)}
				<p class="status error" role="alert">
					{t('ReportStudyPage.viewFailed', { error: error instanceof Error ? error.message : String(error) })}
				</p>
			{/snippet}
		</svelte:boundary>
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

	.retry-row {
		display: flex;
		justify-content: center;
		margin-top: 1rem;
	}

	.retry-btn {
		padding: 0.5rem 1.2rem;
		border-radius: 8px;
		border: 1px solid var(--color-border);
		background: transparent;
		color: var(--color-foreground);
		cursor: pointer;
	}

	.retry-btn:hover {
		border-color: var(--color-primary);
		color: var(--color-primary);
	}

	.retry-btn:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
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
		overflow-wrap: anywhere;
		min-width: 0;
	}

	.source-link:hover {
		color: var(--color-primary);
		border-color: var(--color-primary);
	}
</style>
