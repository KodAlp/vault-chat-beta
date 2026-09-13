<script lang="ts">
	import { onMount } from 'svelte';
	import { libraryViewerUrl } from '$lib/sourceLink';
	import type { PageProps } from './$types';
	import type { SlideDeckView, SlideView } from '$lib/types';
	import ExternalLinkIcon from '@lucide/svelte/icons/external-link';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';

	let { data }: PageProps = $props();

	type Phase = 'loading' | 'ready' | 'error';

	let phase = $state<Phase>('loading');
	let deck = $state<SlideDeckView | null>(null);
	let slides = $state<SlideView[]>([]);
	/** Each entry is a self-contained srcdoc for one <iframe sandbox="">,
	 * built from Marp's `div.marpit > svg > foreignObject > section` output —
	 * the CSS is strictly scoped to that exact ancestor chain (verified
	 * against a real render), so extracting a bare <section> alone would
	 * match none of it. Full CSS isolation from the app's own styles either
	 * direction; sandbox="" (no allow-scripts) since nothing here needs JS. */
	let slideDocs = $state<string[]>([]);
	let currentIndex = $state(0);
	let errorMessage = $state('');

	// See study/quiz/[id]/+page.svelte's comment on quizQuery — an empty
	// `vault=` param is not the same as an absent one.
	let slidesQuery = $derived(data.vaultId ? `?vault=${encodeURIComponent(data.vaultId)}` : '');

	onMount(async () => {
		try {
			const res = await fetch(`/api/study/slidedecks/${data.slideDeckId}${slidesQuery}`);
			if (!res.ok) throw new Error();
			const body = (await res.json()) as { deck: SlideDeckView; slides: SlideView[] };
			deck = body.deck;
			slides = body.slides;
			if (slides.length === 0) {
				errorMessage = 'Bu sunumda slayt yok.';
				phase = 'error';
				return;
			}

			const parser = new DOMParser();
			const parsed = parser.parseFromString(body.deck.rendered_html, 'text/html');
			const svgs = Array.from(parsed.querySelectorAll('svg[data-marpit-svg]'));
			slideDocs = svgs.map(
				(svg) => `<style>${body.deck.rendered_css}</style><div class="marpit">${svg.outerHTML}</div>`
			);
			if (slideDocs.length === 0) {
				errorMessage = 'Slaytlar render edilemedi.';
				phase = 'error';
				return;
			}
			phase = 'ready';
		} catch {
			errorMessage = 'Sunum yüklenemedi.';
			phase = 'error';
		}
	});

	function next() {
		if (currentIndex < slideDocs.length - 1) currentIndex++;
	}

	function prev() {
		if (currentIndex > 0) currentIndex--;
	}
</script>

<svelte:head>
	<title>{deck?.title ?? 'Sunum'} — Vault Agent Toolkit</title>
</svelte:head>

<div class="slides-screen">
	<a class="home-link" href="/"><ArrowLeftIcon size={14} aria-hidden="true" /> Ana sayfa</a>

	<!-- See study/report/[id]/+page.svelte for why every one of these view
	     routes gets a boundary: phase='ready' is assigned before its subtree
	     has rendered once, so a render-time throw leaves the DOM frozen on
	     "Yükleniyor..." with nothing explaining it. -->
	<svelte:boundary>
	{#if phase === 'loading'}
		<p class="status">Yükleniyor...</p>
	{:else if phase === 'error'}
		<p class="status error" role="alert">{errorMessage}</p>
	{:else if phase === 'ready' && deck}
		<h1>{deck.title}</h1>

		<p class="progress-label">{currentIndex + 1} / {slideDocs.length}</p>
		<div class="slide-frame">
			<iframe title="Slayt {currentIndex + 1}" sandbox="" srcdoc={slideDocs[currentIndex]}></iframe>
		</div>

		<div class="nav">
			<button onclick={prev} disabled={currentIndex === 0}>‹ Geri</button>
			<button onclick={next} disabled={currentIndex === slideDocs.length - 1}>İleri ›</button>
		</div>

		{#if slides[currentIndex]}
			<div class="citation-row">
				<a
					class="source-link"
					href={libraryViewerUrl(slides[currentIndex].source_path, data.vaultId ?? '')}
				>
					{slides[currentIndex].source_path}
				</a>
				<a
					class="source-link"
					href={libraryViewerUrl(slides[currentIndex].source_path, data.vaultId ?? '')}
					title="Kaynağı aç"
					aria-label="Kaynağı aç"
				>
					<ExternalLinkIcon size={13} aria-hidden="true" />
				</a>
			</div>
		{/if}
	{/if}
	{#snippet failed(error)}
		<p class="status error" role="alert">
			Sunum görüntülenemedi: {error instanceof Error ? error.message : String(error)}
		</p>
	{/snippet}
	</svelte:boundary>
</div>

<style>
	.slides-screen {
		max-width: 960px;
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
		margin: 0 0 0.75rem;
	}

	.progress-label {
		font-size: 0.75rem;
		color: var(--color-muted-foreground);
		margin: 0 0 0.5rem;
	}

	.slide-frame {
		width: 100%;
		aspect-ratio: 16 / 9;
		border: 1px solid var(--color-border);
		border-radius: 10px;
		overflow: hidden;
	}

	.slide-frame iframe {
		width: 100%;
		height: 100%;
		border: none;
	}

	.nav {
		display: flex;
		justify-content: space-between;
		margin-top: 1rem;
	}

	.nav button {
		padding: 0.5rem 1.2rem;
		border-radius: 8px;
		border: 1px solid var(--color-border);
		background: transparent;
		color: var(--color-foreground);
		cursor: pointer;
	}

	.nav button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.citation-row {
		display: flex;
		gap: 0.4rem;
		margin-top: 1rem;
	}

	.source-link {
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
