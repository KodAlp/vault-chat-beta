<script lang="ts">
	import { onMount } from 'svelte';
	import { renderMarkdown } from '$lib/markdown';
	import { obsidianUri, libraryViewerUrl } from '$lib/sourceLink';
	import type { CardView, Grade } from '$lib/types';

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
	<title>Bilgi Kartları — Vault Chat</title>
</svelte:head>

<div class="cards-screen">
	<a class="home-link" href="/">← Ana sayfa</a>

	{#if phase === 'loading'}
		<p class="status">Yükleniyor...</p>
	{:else if phase === 'error'}
		<p class="status error">{errorMessage}</p>
	{:else if phase === 'empty'}
		<p class="status">Bugün tekrarlanacak kart yok.</p>
	{:else if phase === 'done'}
		<p class="status">Bugün için bitti — {reviewedCount} kart tekrar edildi.</p>
	{:else if phase === 'reviewing' || phase === 'grading'}
		{@const card = cards[currentIndex]}
		<div class="progress-bar">
			<div class="progress-fill" style="width: {((currentIndex + 1) / cards.length) * 100}%"></div>
		</div>
		<p class="progress-label">{currentIndex + 1} / {cards.length}</p>

		<div class="card-box">
			<div class="face front">{@html frontHtml}</div>
			{#if revealed}
				<hr />
				<div class="face back">{@html backHtml}</div>
				<a class="source-link" href={obsidianUri(card.source_path)} title={card.heading_path}>
					{card.source_path}
				</a>
				<a class="source-link" href={libraryViewerUrl(card.source_path)} title="Kütüphanede görüntüle">
					⇱
				</a>
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

	.progress-bar {
		height: 6px;
		background: var(--border);
		border-radius: 999px;
		overflow: hidden;
	}

	.progress-fill {
		height: 100%;
		background: var(--primary);
		transition: width 0.2s ease;
	}

	.progress-label {
		font-size: 0.75rem;
		color: var(--muted-foreground);
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
		border-top: 1px solid var(--border);
		margin: 1rem 0;
	}

	.source-link {
		display: inline-block;
		margin-top: 0.9rem;
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

	.reveal {
		display: block;
		width: 100%;
		padding: 0.6rem 1rem;
		border-radius: 8px;
		border: 1px solid var(--border);
		background: transparent;
		color: var(--foreground);
		cursor: pointer;
		font-size: 0.95rem;
	}

	.reveal:hover {
		border-color: var(--primary);
		color: var(--primary);
	}

	.grades {
		display: flex;
		gap: 0.6rem;
	}

	.grade {
		flex: 1;
		padding: 0.6rem 0.5rem;
		border-radius: 8px;
		border: 1px solid var(--border);
		background: transparent;
		color: var(--foreground);
		cursor: pointer;
		font-size: 0.9rem;
		font-weight: 600;
	}

	.grade:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.grade.again {
		border-color: var(--destructive);
		color: var(--destructive);
	}

	.grade.good {
		border-color: var(--primary);
		color: var(--primary);
	}
</style>
