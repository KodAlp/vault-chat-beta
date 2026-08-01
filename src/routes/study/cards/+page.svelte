<script lang="ts">
	import { onMount } from 'svelte';
	import { renderMarkdown } from '$lib/markdown';
	import { obsidianUri, libraryViewerUrl } from '$lib/sourceLink';
	import type { CardView, Grade } from '$lib/types';
	import BookOpenIcon from '@lucide/svelte/icons/book-open';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';

	type Phase = 'loading' | 'reviewing' | 'grading' | 'done' | 'empty' | 'error';

	let phase = $state<Phase>('loading');
	let cards = $state<CardView[]>([]);
	let currentIndex = $state(0);
	let revealed = $state(false);
	let reviewedCount = $state(0);
	let errorMessage = $state('');

	let frontHtml = $state('');
	let backHtml = $state('');

	onMount(async () => {
		try {
			const res = await fetch('/api/study/cards/queue');
			if (!res.ok) throw new Error();
			const data = (await res.json()) as { cards: CardView[] };
			cards = data.cards;
			phase = cards.length === 0 ? 'empty' : 'reviewing';
		} catch {
			errorMessage = 'Kartlar yüklenemedi.';
			phase = 'error';
		}
	});

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
				body: JSON.stringify({ grade: g })
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
	<title>Bilgi Kartları — Vault Agent Toolkit</title>
</svelte:head>

<div class="cards-screen">
	<a class="home-link" href="/"><ArrowLeftIcon size={14} aria-hidden="true" /> Ana sayfa</a>

	{#if phase === 'loading'}
		<p class="status">Yükleniyor...</p>
	{:else if phase === 'error'}
		<p class="status error" role="alert">{errorMessage}</p>
	{:else if phase === 'empty'}
		<p class="status">Bugün tekrarlanacak kart yok.</p>
	{:else if phase === 'done'}
		<p class="status">Bugün için bitti — {reviewedCount} kart tekrar edildi.</p>
	{:else if phase === 'reviewing' || phase === 'grading'}
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
					<a class="chip" href={obsidianUri(card.source_path)} title={card.heading_path}>
						{card.source_path}
					</a>
					<a class="chip-icon" href={libraryViewerUrl(card.source_path)} title="Kütüphanede görüntüle" aria-label="Kütüphanede görüntüle">
							<BookOpenIcon size={13} aria-hidden="true" />
						</a>
					</span>
				{/if}
		</div>

		{#if !revealed}
			<button class="reveal" onclick={reveal}>Cevabı göster</button>
		{:else}
			<div class="grades">
				<button class="grade again" onclick={() => grade('again')} disabled={phase === 'grading'}>
					Tekrar
				</button>
				<button class="grade hard" onclick={() => grade('hard')} disabled={phase === 'grading'}>
					Zor
				</button>
				<button class="grade good" onclick={() => grade('good')} disabled={phase === 'grading'}>
					İyi
				</button>
				<button class="grade easy" onclick={() => grade('easy')} disabled={phase === 'grading'}>
					Kolay
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
