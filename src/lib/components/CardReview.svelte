<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { renderMarkdown } from '$lib/markdown';
	import { libraryViewerUrl } from '$lib/sourceLink';
	import { t } from '$lib/i18n/index.svelte';
	import { readResponseError, localizeError } from '$lib/server-error';
	import type { CardView, Grade } from '$lib/types';
	import ExternalLinkIcon from '@lucide/svelte/icons/external-link';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';

	/**
	 * The flashcard review session — front/reveal/grade, spaced-repetition
	 * scheduling via /api/study/cards/[id]/grade — extracted from
	 * /study/cards/+page.svelte (Faz — per-deck review) so /study/cards/[id]
	 * (a specific deck) can reuse it instead of duplicating ~250 lines of
	 * markup/CSS. The two callers differ only in WHICH cards get reviewed
	 * (fetchUrl) and what "nothing to show" means for that source
	 * (emptyMessage) — everything else (rendering, grading, progress) is
	 * identical.
	 */
	let {
		fetchUrl,
		vaultId,
		backHref,
		here,
		titleFallback,
		emptyMessage
	}: {
		/** Either the flat cross-deck due queue or a single deck's cards —
		 * see study-db.ts's getDueCards vs getDeckCards doc comments for why
		 * these are genuinely different, not just two URLs for the same
		 * data. Both respond {cards: CardView[]}; the deck endpoint also
		 * includes {deckName}, used for the page title if present. */
		fetchUrl: string;
		vaultId: string | undefined;
		backHref: string;
		here: string;
		titleFallback: string;
		emptyMessage?: string;
	} = $props();

	type Phase = 'loading' | 'reviewing' | 'grading' | 'done' | 'empty' | 'error';

	let phase = $state<Phase>('loading');
	let notFound = $state(false);
	let cards = $state<CardView[]>([]);
	let currentIndex = $state(0);
	let revealed = $state(false);
	let reviewedCount = $state(0);
	let errorMessage = $state('');
	// untrack: a deliberate one-time seed, not a live binding to the prop —
	// once the fetch resolves, pageTitle switches to the deck's real name
	// (see onMount below) and has no reason to snap back if titleFallback
	// were ever to change.
	let pageTitle = $state(untrack(() => titleFallback));

	let frontHtml = $state('');
	let backHtml = $state('');

	async function load() {
		phase = 'loading';
		notFound = false;
		errorMessage = '';
		try {
			const res = await fetch(fetchUrl);
			if (!res.ok) {
				if (res.status === 404) {
					notFound = true;
				} else {
					errorMessage = await readResponseError(res);
				}
				phase = 'error';
				return;
			}
			const body = (await res.json()) as { cards: CardView[]; deckName?: string };
			cards = body.cards;
			if (body.deckName) pageTitle = body.deckName;
			phase = cards.length === 0 ? 'empty' : 'reviewing';
		} catch (err) {
			errorMessage = localizeError({ message: err instanceof Error ? err.message : undefined });
			phase = 'error';
		}
	}

	onMount(load);

	$effect(() => {
		const card = cards[currentIndex];
		if (!card || phase !== 'reviewing') return;
		revealed = false;
		renderMarkdown(card.front).then((html) => (frontHtml = html));
		renderMarkdown(card.back).then((html) => (backHtml = html));
	});

	function reveal() {
		revealed = true;
	}

	async function grade(g: Grade) {
		const card = cards[currentIndex];
		if (!card || phase === 'grading') return;
		phase = 'grading';
		try {
			await fetch(`/api/study/cards/${card.id}/grade`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ grade: g, vault: vaultId })
			});
		} catch {
			// scheduling update failed silently — worst case this card is re-shown
			// sooner than intended next session, not a data-loss scenario.
		}
		reviewedCount++;
		if (currentIndex < cards.length - 1) {
			currentIndex++;
			phase = 'reviewing';
		} else {
			phase = 'done';
		}
	}
</script>

<svelte:head>
	<title>{pageTitle} — Vault Agent Toolkit</title>
</svelte:head>

<div class="cards-screen">
	<a class="home-link" href={backHref}><ArrowLeftIcon size={14} aria-hidden="true" /> {t('Common.geriDon')}</a>

	{#if phase === 'loading'}
		<p class="status">{t('Common.yukleniyor')}</p>
	{:else if phase === 'error'}
		{#if notFound}
			<p class="status error" role="alert">{t('CardsStudyPage.notFoundTitle')}</p>
			<p class="status">{t('CardsStudyPage.notFoundBody')}</p>
		{:else}
			<p class="status error" role="alert">{errorMessage}</p>
			<div class="retry-row">
				<button type="button" class="retry-btn" onclick={load}>{t('Common.yenidenDene')}</button>
			</div>
		{/if}
	{:else if phase === 'empty'}
		<h1>{pageTitle}</h1>
		<p class="status">{emptyMessage ?? t('CardsStudyPage.empty')}</p>
	{:else if phase === 'done'}
		<h1>{pageTitle}</h1>
		<p class="status">{t('CardsStudyPage.done', { count: reviewedCount })}</p>
	{:else if phase === 'reviewing' || phase === 'grading'}
		<h1>{pageTitle}</h1>
		{@const card = cards[currentIndex]}
		<div class="progress-bar">
			<div class="progress-fill" style="transform: scaleX({(currentIndex + 1) / cards.length})"></div>
		</div>
		<p class="progress-label">{currentIndex + 1} / {cards.length}</p>

		<div class="card-box">
			<div class="face front markdown-body">{@html frontHtml}</div>
			{#if revealed}
				<hr />
				<div class="face back markdown-body">{@html backHtml}</div>
				<span class="chip-group">
					<a class="chip" href={libraryViewerUrl(card.source_path, vaultId ?? '', here)} title={card.heading_path}>
						{card.source_path}
					</a>
					<a class="chip-icon" href={libraryViewerUrl(card.source_path, vaultId ?? '', here)} title={t('Common.kaynagiAc')} aria-label={t('Common.kaynagiAc')}>
						<ExternalLinkIcon size={13} aria-hidden="true" />
					</a>
					</span>
				{/if}
		</div>

		{#if !revealed}
			<button class="reveal" onclick={reveal}>{t('CardsStudyPage.reveal')}</button>
		{:else}
			<div class="grades">
				<button class="grade again" onclick={() => grade('again')} disabled={phase === 'grading'}>
					{t('CardsStudyPage.gradeAgain')}
				</button>
				<button class="grade hard" onclick={() => grade('hard')} disabled={phase === 'grading'}>
					{t('CardsStudyPage.gradeHard')}
				</button>
				<button class="grade good" onclick={() => grade('good')} disabled={phase === 'grading'}>
					{t('CardsStudyPage.gradeGood')}
				</button>
				<button class="grade easy" onclick={() => grade('easy')} disabled={phase === 'grading'}>
					{t('CardsStudyPage.gradeEasy')}
				</button>
			</div>
		{/if}
	{/if}
</div>

<style>
	.cards-screen {
		max-width: 640px;
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

	.cards-screen h1 {
		font-family: var(--font-display);
		font-weight: 480;
		letter-spacing: -0.015em;
		font-size: 1.5rem;
		margin: 0 0 1.5rem;
	}

	.progress-bar {
		height: 6px;
		background: var(--color-border);
		border-radius: 999px;
		overflow: hidden;
	}

	.progress-fill {
		height: 100%;
		width: 100%;
		background: var(--color-primary);
		/* scaleX, not width — the fill never triggers layout recalculation
		   on its own track (its parent .progress-bar's size is fixed). */
		transform-origin: left;
		transition: transform var(--motion-base) var(--motion-easing);
	}

	.progress-label {
		font-size: 0.75rem;
		color: var(--color-muted-foreground);
		margin: 0.4rem 0 1.5rem;
	}

	.card-box {
		background: var(--bubble-assistant);
		border-radius: 10px;
		padding: 1.5rem;
		margin-bottom: 1.5rem;
		min-height: 8rem;
	}

	.face {
		line-height: 1.6;
	}

	.card-box hr {
		border: none;
		border-top: 1px solid var(--color-border);
		margin: 1rem 0;
	}

	.chip-group {
		display: inline-flex;
		align-items: stretch;
		margin-top: 0.9rem;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-pill);
		overflow: hidden;
	}

	.chip {
		font-size: 0.75rem;
		text-decoration: none;
		color: var(--color-muted-foreground);
		padding: 0.2rem 0.65rem;
		overflow-wrap: anywhere;
		min-width: 0;
	}

	.chip:hover {
		color: var(--color-primary);
	}

	.chip-icon {
		display: inline-flex;
		align-items: center;
		text-decoration: none;
		color: var(--color-muted-foreground);
		padding: 0.2rem 0.5rem;
		border-left: 1px solid var(--color-border);
	}

	.chip-icon:hover {
		color: var(--color-primary);
	}

	.chip:focus-visible,
	.chip-icon:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: -2px;
	}

	.reveal {
		display: block;
		width: 100%;
		padding: 0.6rem 1rem;
		border-radius: 8px;
		border: 1px solid var(--color-border);
		background: transparent;
		color: var(--color-foreground);
		cursor: pointer;
		font-size: 1rem;
	}

	.reveal:hover {
		border-color: var(--color-primary);
		color: var(--color-primary);
	}

	.reveal:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}

	.grades {
		display: flex;
		gap: 0.6rem;
	}

	.grade {
		flex: 1;
		padding: 0.6rem 0.5rem;
		border-radius: 8px;
		border: 1px solid var(--color-border);
		background: transparent;
		color: var(--color-foreground);
		cursor: pointer;
		font-size: 0.9rem;
		font-weight: 600;
	}

	.grade:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.grade:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}

	.grade.again {
		border-color: var(--color-destructive);
		color: var(--color-destructive);
	}

	.grade.good {
		border-color: var(--color-primary);
		color: var(--color-primary);
	}
</style>
