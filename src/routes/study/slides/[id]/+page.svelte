<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { libraryViewerUrl } from '$lib/sourceLink';
	import { resolveBackHref } from '$lib/back-link';
	import { t } from '$lib/i18n/index.svelte';
	import { readResponseError, localizeError } from '$lib/server-error';
	import type { PageProps } from './$types';
	import type { SlideDeckView, SlideView } from '$lib/types';

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

	async function load() {
		phase = 'loading';
		notFound = false;
		errorMessage = '';
		try {
			const res = await fetch(`/api/study/slidedecks/${data.slideDeckId}${slidesQuery}`);
			if (!res.ok) {
				if (res.status === 404) {
					notFound = true;
				} else {
					errorMessage = await readResponseError(res);
				}
				phase = 'error';
				return;
			}
			const body = (await res.json()) as { deck: SlideDeckView; slides: SlideView[] };
			deck = body.deck;
			slides = body.slides;
			if (slides.length === 0) {
				errorMessage = t('SlidesStudyPage.noSlides');
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
				errorMessage = t('SlidesStudyPage.renderFailed');
				phase = 'error';
				return;
			}
			phase = 'ready';
		} catch (err) {
			errorMessage = localizeError({ message: err instanceof Error ? err.message : undefined });
			phase = 'error';
		}
	}

	onMount(load);

	function next() {
		if (currentIndex < slideDocs.length - 1) currentIndex++;
	}

	function prev() {
		if (currentIndex > 0) currentIndex--;
	}
</script>

<svelte:head>
	<title>{deck?.title ?? t('SlidesStudyPage.defaultTitle')} — Vault Chat</title>
</svelte:head>

<div class="slides-screen">
	<a class="home-link" href={backHref}><Icon name="arrow-left" size="sm" class="rtl-flip" /> {t('Common.geriDon')}</a>

	<!-- See study/report/[id]/+page.svelte for why every one of these view
	     routes gets a boundary: phase='ready' is assigned before its subtree
	     has rendered once, so a render-time throw leaves the DOM frozen on
	     "Yükleniyor..." with nothing explaining it. -->
	<svelte:boundary>
	{#if phase === 'loading'}
		<p class="status">{t('Common.yukleniyor')}</p>
	{:else if phase === 'error'}
		{#if notFound}
			<p class="status error" role="alert">{t('SlidesStudyPage.notFoundTitle')}</p>
			<p class="status">{t('SlidesStudyPage.notFoundBody')}</p>
		{:else}
			<p class="status error" role="alert">{errorMessage}</p>
			<div class="retry-row">
				<button type="button" class="retry-btn" onclick={load}>{t('Common.yenidenDene')}</button>
			</div>
		{/if}
	{:else if phase === 'ready' && deck}
		<h1>{deck.title}</h1>

		<p class="progress-label">{currentIndex + 1} / {slideDocs.length}</p>
		<div class="slide-frame">
			<iframe title={t('SlidesStudyPage.slideAria', { index: currentIndex + 1 })} sandbox="" srcdoc={slideDocs[currentIndex]}></iframe>
		</div>

		<div class="nav">
			<button class="vc-btn secondary" onclick={prev} disabled={currentIndex === 0}>{t('SlidesStudyPage.prev')}</button>
			<button class="vc-btn secondary" onclick={next} disabled={currentIndex === slideDocs.length - 1}>{t('SlidesStudyPage.next')}</button>
		</div>

		{#if slides[currentIndex]}
			<div class="citation-row">
				<a
					class="source-link"
					href={libraryViewerUrl(slides[currentIndex].source_path, data.vaultId ?? '', here)}
				>
					{slides[currentIndex].source_path}
				</a>
				<a
					class="source-link"
					href={libraryViewerUrl(slides[currentIndex].source_path, data.vaultId ?? '', here)}
					title={t('Common.kaynagiAc')}
					aria-label={t('Common.kaynagiAc')}
				>
					<Icon name="external-link" size="sm" />
				</a>
			</div>
		{/if}
	{/if}
	{#snippet failed(error)}
		<p class="status error" role="alert">
			{t('SlidesStudyPage.viewFailed', { error: error instanceof Error ? error.message : String(error) })}
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

	h1 {
		font: var(--text-display-title);
		margin: 0 0 0.75rem;
	}

	.progress-label {
		font: var(--text-caption-1);
		color: var(--label-secondary);
		margin: 0 0 0.5rem;
	}

	.slide-frame {
		width: 100%;
		aspect-ratio: 16 / 9;
		box-shadow: inset 0 0 0 1px var(--separator);
		border-radius: var(--radius-lg);
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

	.citation-row {
		display: flex;
		gap: 0.4rem;
		margin-top: 1rem;
	}

	.source-link {
		font: var(--text-caption-1);
		color: var(--label-secondary);
		text-decoration: none;
		box-shadow: inset 0 0 0 1px var(--separator);
		border-radius: 999px;
		padding: 0.2rem 0.65rem;
		overflow-wrap: anywhere;
		min-width: 0;
	}

	.source-link:hover {
		color: var(--label);
		background: var(--fill-hover);
	}
</style>
