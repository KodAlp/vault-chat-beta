<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import { onMount, untrack } from 'svelte';
	import { renderMarkdown } from '$lib/markdown';
	import { libraryViewerUrl } from '$lib/sourceLink';
	import { t } from '$lib/i18n/index.svelte';
	import { readResponseError, localizeError } from '$lib/server-error';
	import type { CardView, Grade } from '$lib/types';

	/**
	 * The flashcard review session — front/reveal/grade, spaced-repetition
	 * scheduling via /api/study/cards/[id]/grade — extracted from
	 * /study/cards/+page.svelte (per-deck review) so /study/cards/[id]
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
	<title>{pageTitle} — Vault Chat</title>
</svelte:head>

<div class="cards-screen">
	<a class="home-link" href={backHref}><Icon name="arrow-left" size="sm" class="rtl-flip" /> {t('Common.geriDon')}</a>

	{#if phase === 'loading'}
		<p class="status">{t('Common.yukleniyor')}</p>
	{:else if phase === 'error'}
		{#if notFound}
			<p class="status error" role="alert">{t('CardsStudyPage.notFoundTitle')}</p>
			<p class="status">{t('CardsStudyPage.notFoundBody')}</p>
		{:else}
			<p class="status error" role="alert">{errorMessage}</p>
			<div class="retry-row">
				<button type="button" class="vc-btn secondary" onclick={load}>{t('Common.yenidenDene')}</button>
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
		<div class="vc-progress">
			<span style="width: 100%; transform: scaleX({(currentIndex + 1) / cards.length})"></span>
		</div>
		<p class="progress-label">{currentIndex + 1} / {cards.length}</p>

		<div class="vc-card card-box">
			{#key currentIndex}
				<div class="card-content">
					<div class="face front markdown-body">{@html frontHtml}</div>
					{#if revealed}
						<div class="answer-reveal">
							<hr />
							<div class="face back markdown-body">{@html backHtml}</div>
							<span class="chip-group">
								<a class="chip" href={libraryViewerUrl(card.source_path, vaultId ?? '', here, card.heading_path)} title={card.heading_path}>
									{card.source_path}
								</a>
								<a class="chip-icon" href={libraryViewerUrl(card.source_path, vaultId ?? '', here, card.heading_path)} title={t('Common.kaynagiAc')} aria-label={t('Common.kaynagiAc')}>
									<Icon name="external-link" size="sm" />
								</a>
							</span>
						</div>
					{/if}
				</div>
			{/key}
		</div>

		{#if !revealed}
			<button class="vc-btn primary lg reveal" onclick={reveal}>{t('CardsStudyPage.reveal')}</button>
		{:else}
			<div class="vc-grade grades">
				<button class="vc-btn secondary grade again" onclick={() => grade('again')} disabled={phase === 'grading'}>
					{t('CardsStudyPage.gradeAgain')}
				</button>
				<button class="vc-btn secondary grade hard" onclick={() => grade('hard')} disabled={phase === 'grading'}>
					{t('CardsStudyPage.gradeHard')}
				</button>
				<button class="vc-btn primary grade good" onclick={() => grade('good')} disabled={phase === 'grading'}>
					{t('CardsStudyPage.gradeGood')}
				</button>
				<button class="vc-btn secondary grade easy" onclick={() => grade('easy')} disabled={phase === 'grading'}>
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
		padding: var(--space-6) var(--space-4) var(--space-14);
	}

	.home-link {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		font: var(--text-subheadline);
		color: var(--label-secondary);
		text-decoration: none;
		margin-bottom: var(--space-6);
	}

	.home-link:hover {
		color: var(--label);
	}

	.home-link:focus-visible {
		outline: 2px solid var(--focus-ring);
		outline-offset: 2px;
	}

	.status {
		font: var(--text-body);
		color: var(--label-secondary);
		text-align: center;
		margin-top: 3rem;
	}

	.status.error {
		color: var(--danger);
	}

	.retry-row {
		display: flex;
		justify-content: center;
		margin-top: 1rem;
	}

	.cards-screen h1 {
		font: var(--text-display-title);
		margin: 0 0 var(--space-6);
	}

	/* scaleX, not width — the fill never triggers layout recalculation on
	   its own track (its parent .vc-progress's size is fixed). */
	.vc-progress > span {
		transform-origin: left;
		transition: transform var(--motion-base) var(--motion-easing);
	}

	.progress-label {
		font: var(--text-footnote);
		color: var(--label-secondary);
		margin: 0.4rem 0 var(--space-6);
	}

	.card-box {
		max-width: none;
		margin-bottom: var(--space-6);
	}

	.face {
		line-height: 1.6;
	}

	/* Flashcard front: Newsreader 28/34 (Flashcard.html's .q). */
	.face.front {
		font: var(--text-display-title);
		font-size: 28px;
		line-height: 34px;
		letter-spacing: -0.2px;
	}

	.face.back {
		font: var(--text-body-reading);
	}

	/* Advancing to the next card (Task 7b) — enter-only: opacity + a small
	   translateX, keyed on currentIndex so it replays per card. No exit
	   animation (the outgoing card is simply gone, not animated away). */
	.card-content {
		animation: card-enter var(--motion-base) var(--motion-easing);
	}

	@keyframes card-enter {
		from {
			opacity: 0;
			transform: translateX(8px);
		}
		to {
			opacity: 1;
			transform: translateX(0);
		}
	}

	/* Revealing the answer (Task 7a) — a top-down uncovering via clip-path,
	   not a height/layout animation. */
	.answer-reveal {
		animation: answer-reveal var(--motion-base) var(--motion-easing);
	}

	@keyframes answer-reveal {
		from {
			clip-path: inset(0 0 100% 0);
		}
		to {
			clip-path: inset(0);
		}
	}

	.card-box hr {
		border: none;
		border-top: 1px solid var(--separator);
		margin: 1rem 0;
	}

	.chip-group {
		display: inline-flex;
		align-items: stretch;
		margin-top: 0.9rem;
		box-shadow: inset 0 0 0 1px var(--separator-strong);
		border-radius: var(--radius-full);
		overflow: hidden;
	}

	.chip {
		font: var(--text-caption-1);
		text-decoration: none;
		color: var(--label-secondary);
		padding: 0.2rem 0.65rem;
		overflow-wrap: anywhere;
		min-width: 0;
	}

	.chip:hover {
		color: var(--label);
	}

	.chip-icon {
		display: inline-flex;
		align-items: center;
		text-decoration: none;
		color: var(--label-secondary);
		padding: 0.2rem 0.5rem;
		border-inline-start: 1px solid var(--separator);
	}

	.chip-icon:hover {
		color: var(--label);
	}

	.chip:focus-visible,
	.chip-icon:focus-visible {
		outline: 2px solid var(--focus-ring);
		outline-offset: -2px;
	}

	.reveal {
		display: flex;
		width: 100%;
		max-width: none;
	}

	.grades {
		max-width: none;
	}

	.vc-btn:focus-visible {
		outline: 2px solid var(--focus-ring);
		outline-offset: 2px;
	}
</style>
