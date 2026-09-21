<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { resolveBackHref } from '$lib/back-link';
	import { t } from '$lib/i18n/index.svelte';
	import { UNKNOWN_DOMAIN, type LearnerProfile, type MasteryEstimate, type RetentionEstimate, type SkillNode } from '$lib/learner-model';
	import type { PageProps } from './$types';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';

	let { data }: PageProps = $props();

	// See back-link.ts — falls back to the vault's chat list when this page was opened directly.
	let backHref = $derived(resolveBackHref(page.url.searchParams.get('from'), data.vaultId ? `/vault/${data.vaultId}` : '/'));

	let phase = $state<'loading' | 'ready' | 'error'>('loading');
	let profile = $state<LearnerProfile | null>(null);
	let expanded = $state<Record<string, boolean>>({});

	onMount(async () => {
		try {
			const query = data.vaultId ? `?vault=${encodeURIComponent(data.vaultId)}` : '';
			const res = await fetch(`/api/study/learner${query}`);
			if (!res.ok) throw new Error(String(res.status));
			profile = (await res.json()) as LearnerProfile;
			phase = 'ready';
		} catch {
			phase = 'error';
		}
	});

	let overall = $derived(profile?.nodes.find((n) => n.kind === 'overall') ?? null);
	let domains = $derived(profile?.nodes.filter((n) => n.kind === 'domain') ?? []);
	let isEmpty = $derived(overall !== null && overall.quiz.count === 0 && overall.retention.cards === 0);

	function notesOf(domain: SkillNode): SkillNode[] {
		if (!profile) return [];
		const key = domain.name;
		return profile.nodes.filter((n) => n.kind === 'note' && (n.domains && n.domains.length > 0 ? n.domains.includes(key) : key === UNKNOWN_DOMAIN));
	}
	const domainLabel = (n: SkillNode) => (n.name === UNKNOWN_DOMAIN ? t('ProgressPage.unknownDomain') : n.name);
	const pct = (x: number) => Math.round(x * 100);
	const confidenceLabel = (e: MasteryEstimate) => (e.confidence === 'high' ? t('ProgressPage.confidenceHigh') : t('ProgressPage.confidenceModerate'));
	const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString() : '');
</script>

{#snippet quizRow(label: string, e: MasteryEstimate)}
	<div class="metric">
		<span class="metric-label">{label}</span>
		{#if e.count === 0}
			<span class="muted">{t('ProgressPage.noAnswers')}</span>
		{:else if e.reliable && e.mastery !== null}
			<div class="meter" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct(e.mastery)}>
				<div class="fill" style:width="{pct(e.mastery)}%"></div>
			</div>
			<span class="value">{pct(e.mastery)}%</span>
			<span class="muted small">{t('ProgressPage.answers', { count: e.count })} · {confidenceLabel(e)}{e.lastAt ? ` · ${t('ProgressPage.lastAnswered', { date: day(e.lastAt) })}` : ''}</span>
		{:else}
			<span class="muted">{t('ProgressPage.notEnough')}</span>
			<span class="muted small">{t('ProgressPage.answers', { count: e.count })}</span>
		{/if}
	</div>
{/snippet}

{#snippet cardRow(label: string, e: RetentionEstimate)}
	{#if e.cards > 0}
		<div class="metric">
			<span class="metric-label">{label}</span>
			{#if e.reliable && e.retention !== null}
				<div class="meter" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct(e.retention)}>
					<div class="fill card" style:width="{pct(e.retention)}%"></div>
				</div>
				<span class="value">{pct(e.retention)}%</span>
				<span class="muted small">{t('ProgressPage.cards', { count: e.cards })}</span>
			{:else}
				<span class="muted">{t('ProgressPage.notEnough')}</span>
				<span class="muted small">{t('ProgressPage.cards', { count: e.cards })}</span>
			{/if}
		</div>
	{/if}
{/snippet}

{#snippet bandRows(node: SkillNode)}
	{#if node.bands}
		<div class="bands">
			<p class="bands-title">{t('ProgressPage.bandsTitle')}</p>
			{@render quizRow(t('ProgressPage.bandBasic'), node.bands.basic)}
			{@render quizRow(t('ProgressPage.bandApplied'), node.bands.applied)}
			<p class="muted small">{t('ProgressPage.bandsHint')}</p>
		</div>
	{/if}
{/snippet}

<div class="progress-screen">
	<a class="home-link" href={backHref}><ArrowLeftIcon size={16} aria-hidden="true" /> {t('ProgressPage.back')}</a>
	<h1>{t('ProgressPage.title')}</h1>

	{#if phase === 'loading'}
		<p class="status">{t('ProgressPage.loading')}</p>
	{:else if phase === 'error'}
		<p class="status error" role="alert">{t('ProgressPage.loadFailed')}</p>
	{:else if isEmpty}
		<p class="status">{t('ProgressPage.empty')}</p>
	{:else if overall}
		<p class="intro">{t('ProgressPage.intro')}</p>

		<section class="card-block" aria-label={t('ProgressPage.overall')}>
			<h2>{t('ProgressPage.overall')}</h2>
			{@render quizRow(t('ProgressPage.quizAnswers'), overall.quiz)}
			{@render cardRow(t('ProgressPage.cardMemory'), overall.retention)}
			{@render bandRows(overall)}
		</section>

		{#if domains.length > 0}
			<h2 class="section-title">{t('ProgressPage.byDomain')}</h2>
			{#each domains as domain (domain.id)}
				{@const notes = notesOf(domain)}
				<section class="card-block" aria-label={domainLabel(domain)}>
					<h3>{domainLabel(domain)}</h3>
					{@render quizRow(t('ProgressPage.quizAnswers'), domain.quiz)}
					{@render cardRow(t('ProgressPage.cardMemory'), domain.retention)}
					{@render bandRows(domain)}
					{#if notes.length > 0}
						<button type="button" class="toggle" aria-expanded={expanded[domain.id] === true} onclick={() => (expanded[domain.id] = !expanded[domain.id])}>
							<ChevronDownIcon size={16} class={expanded[domain.id] ? 'open' : ''} aria-hidden="true" />
							{expanded[domain.id] ? t('ProgressPage.hideNotes') : t('ProgressPage.showNotes', { count: notes.length })}
						</button>
						{#if expanded[domain.id]}
							<ul class="notes">
								{#each notes as note (note.id)}
									<li>
										<span class="note-name">{note.name}</span>
										{@render quizRow(t('ProgressPage.quizAnswers'), note.quiz)}
										{@render cardRow(t('ProgressPage.cardMemory'), note.retention)}
									</li>
								{/each}
							</ul>
						{/if}
					{/if}
				</section>
			{/each}
		{/if}

		<section class="how">
			<h2>{t('ProgressPage.howTitle')}</h2>
			<p>{t('ProgressPage.howBody')}</p>
		</section>
	{/if}
</div>

<style>
	.progress-screen {
		max-width: 640px;
		margin: 0 auto;
		padding: 1.5rem 1rem 3rem;
	}

	.progress-screen h1 {
		font-family: var(--font-display);
		font-weight: 480;
		letter-spacing: -0.015em;
		font-size: 1.5rem;
		margin: 0 0 1rem;
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

	.home-link:focus-visible,
	.toggle:focus-visible {
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

	.intro {
		color: var(--color-muted-foreground);
		font-size: 0.9rem;
		line-height: 1.5;
		margin: 0 0 1.25rem;
	}

	.card-block {
		border: 1px solid var(--color-border);
		border-radius: var(--radius-lg);
		padding: 1rem 1.1rem;
		margin-bottom: 0.9rem;
	}

	.card-block h2,
	.card-block h3 {
		font-size: 1rem;
		font-weight: 600;
		margin: 0 0 0.75rem;
	}

	.section-title {
		font-family: var(--font-display);
		font-weight: 480;
		font-size: 1.1rem;
		margin: 1.75rem 0 0.75rem;
	}

	.metric {
		display: grid;
		grid-template-columns: 8.5rem 1fr auto;
		align-items: center;
		gap: 0.25rem 0.75rem;
		margin-bottom: 0.6rem;
	}

	.metric-label {
		font-size: 0.85rem;
		color: var(--color-foreground);
	}

	.metric .small {
		grid-column: 2 / 4;
	}

	.meter {
		height: 0.55rem;
		border-radius: 999px;
		background: var(--color-border);
		overflow: hidden;
	}

	.fill {
		height: 100%;
		background: var(--color-primary);
		border-radius: 999px;
	}

	.fill.card {
		background: var(--accent);
	}

	.value {
		font-variant-numeric: tabular-nums;
		font-weight: 600;
		font-size: 0.9rem;
	}

	.muted {
		color: var(--color-muted-foreground);
	}

	.small {
		font-size: 0.75rem;
	}

	.metric > .muted:not(.small) {
		grid-column: 2 / 4;
		font-size: 0.85rem;
	}

	.bands {
		margin-top: 0.9rem;
		padding-top: 0.75rem;
		border-top: 1px dashed var(--color-border);
	}

	.bands-title {
		font-size: 0.8rem;
		color: var(--color-muted-foreground);
		margin: 0 0 0.5rem;
	}

	.toggle {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		background: none;
		border: none;
		padding: 0.25rem 0;
		margin-top: 0.4rem;
		font-size: 0.85rem;
		color: var(--color-primary);
		cursor: pointer;
	}

	.toggle :global(.open) {
		transform: rotate(180deg);
	}

	.notes {
		list-style: none;
		padding: 0;
		margin: 0.6rem 0 0;
	}

	.notes li {
		padding: 0.6rem 0;
		border-top: 1px solid var(--color-border);
	}

	.note-name {
		display: block;
		font-size: 0.85rem;
		font-weight: 600;
		margin-bottom: 0.4rem;
		overflow-wrap: anywhere;
	}

	.how {
		margin-top: 1.75rem;
		color: var(--color-muted-foreground);
		font-size: 0.85rem;
		line-height: 1.55;
	}

	.how h2 {
		font-size: 0.95rem;
		font-weight: 600;
		color: var(--color-foreground);
		margin: 0 0 0.4rem;
	}

	@media (max-width: 480px) {
		.metric {
			grid-template-columns: 1fr auto;
		}

		.metric-label,
		.meter {
			grid-column: 1 / 3;
		}
	}
</style>
