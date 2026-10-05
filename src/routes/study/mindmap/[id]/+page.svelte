<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { page } from '$app/state';
	import { buildTree, treeToMarkdownOutline } from '$lib/mindmap-tree';
	import { libraryViewerUrl } from '$lib/sourceLink';
	import { resolveBackHref } from '$lib/back-link';
	import { t } from '$lib/i18n/index.svelte';
	import { readResponseError, localizeError } from '$lib/server-error';
	import type { PageProps } from './$types';
	import type { MindMapNodeView, MindMapView } from '$lib/types';
	import ExternalLinkIcon from '@lucide/svelte/icons/external-link';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import ZoomInIcon from '@lucide/svelte/icons/zoom-in';
	import ZoomOutIcon from '@lucide/svelte/icons/zoom-out';
	import MaximizeIcon from '@lucide/svelte/icons/maximize';

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
	let mindmap = $state<MindMapView | null>(null);
	let nodes = $state<MindMapNodeView[]>([]);
	let errorMessage = $state('');
	let svgEl = $state<SVGSVGElement | undefined>(undefined);
	/** Wider than markmap needs for a label, narrow enough that a 450-char
	 * explanation wraps into a readable block instead of one very long line.
	 * markmap turns this into `--markmap-max-width`, and because the inner
	 * content box is inline-block, SHORT labels still shrink to fit — only long
	 * text actually wraps. Tune here; it is the only place the number lives. */
	const NODE_MAX_WIDTH = 340;
	const ZOOM_STEP_IN = 1.25;
	const ZOOM_STEP_OUT = 0.8;

	interface MarkmapHandle {
		destroy(): void;
		rescale(scale: number): Promise<void>;
		fit(maxScale?: number): Promise<void>;
		renderData(): Promise<void>;
	}
	// $state, not a plain let: the zoom buttons render disabled until the map
	// actually exists, and that has to be reactive.
	let markmapInstance = $state<MarkmapHandle | undefined>(undefined);

	// See study/quiz/[id]/+page.svelte's comment on quizQuery — an empty
	// `vault=` param is not the same as an absent one.
	let mindmapQuery = $derived(data.vaultId ? `?vault=${encodeURIComponent(data.vaultId)}` : '');

	async function load() {
		phase = 'loading';
		notFound = false;
		errorMessage = '';
		try {
			const res = await fetch(`/api/study/mindmaps/${data.mindmapId}${mindmapQuery}`);
			if (!res.ok) {
				if (res.status === 404) {
					notFound = true;
				} else {
					errorMessage = await readResponseError(res);
				}
				phase = 'error';
				return;
			}
			const body = (await res.json()) as { mindmap: MindMapView; nodes: MindMapNodeView[] };
			mindmap = body.mindmap;
			nodes = body.nodes;
			if (nodes.length === 0) {
				errorMessage = t('MindmapStudyPage.noNodes');
				phase = 'error';
				return;
			}
			phase = 'ready';

			// markmap-lib/markmap-view are D3/DOM-based (not SSR-compatible, though
			// this app never SSRs anyway — ssr=false in +layout.ts) and sizeable;
			// dynamically imported here purely for bundle-splitting so other
			// routes don't pay for them.
			const [{ Transformer }, { Markmap }] = await Promise.all([
				import('markmap-lib'),
				import('markmap-view')
			]);
			const tree = buildTree({ label: mindmap.title, summary: mindmap.rootSummary }, nodes);
			const vaultId = data.vaultId ?? '';
			// Every node gets a link: buildTree() backfills the synthesized
			// structural ancestors from their first cited descendant (see its
			// doc comment), so a branch label is no longer the one thing in the
			// map that silently does nothing when clicked. The null branch is
			// kept because the type allows it, not because it is expected.
			const outline = treeToMarkdownOutline(tree, (node) =>
				node.sourcePath ? libraryViewerUrl(node.sourcePath, vaultId, here) : null
			);
			const { root } = new Transformer().transform(outline);
			if (svgEl) {
				// initialExpandLevel, not markmap's default of -1 ("expand
				// everything"): every concept now carries its explanation and its
				// citation as child nodes, so a fully expanded map opens as a wall
				// of prose. 2 shows the topic, its definition and the main branches
				// — the skeleton — and leaves the rest to be revealed by clicking a
				// node's circle, which is exactly the "tap a node to see what it
				// means" behaviour, using markmap's own collapse/expand.
				markmapInstance = Markmap.create(
					svgEl,
					{ initialExpandLevel: 2, maxWidth: NODE_MAX_WIDTH },
					root
				) as unknown as MarkmapHandle;
			}
		} catch (err) {
			errorMessage = localizeError({ message: err instanceof Error ? err.message : undefined });
			phase = 'error';
		}
	}

	onMount(load);

	/**
	 * Delegated, because markmap rebuilds node DOM on every render — a handler
	 * bound to a summary span would not survive the first collapse.
	 *
	 * After toggling, renderData() is required, not optional: markmap caches
	 * each node's measured size, so without a re-render an expanded paragraph
	 * would overflow its old box and sit on top of its neighbours.
	 */
	function handleMapClick(event: MouseEvent) {
		const target = event.target as HTMLElement | null;
		const summary = target?.closest?.('.mm-summary.is-clamped, .mm-summary.is-expanded');
		if (!summary) return;
		summary.classList.toggle('is-clamped');
		summary.classList.toggle('is-expanded');
		void markmapInstance?.renderData();
	}

	onDestroy(() => {
		markmapInstance?.destroy();
	});
</script>

<svelte:head>
	<title>{mindmap?.title ?? t('MindmapStudyPage.defaultTitle')} — Vault Agent Toolkit</title>
</svelte:head>

<div class="mindmap-screen">
	<a class="home-link" href={backHref}><ArrowLeftIcon class="rtl-flip" size={16} strokeWidth={1.75} aria-hidden="true" /> {t('Common.geriDon')}</a>

	<!-- See study/report/[id]/+page.svelte for why every one of these view
	     routes gets a boundary: phase='ready' is assigned before its subtree
	     has rendered once, so a render-time throw leaves the DOM frozen on
	     "Yükleniyor..." with nothing explaining it. -->
	<svelte:boundary>
	{#if phase === 'loading'}
		<p class="status">{t('Common.yukleniyor')}</p>
	{:else if phase === 'error'}
		{#if notFound}
			<p class="status error" role="alert">{t('MindmapStudyPage.notFoundTitle')}</p>
			<p class="status">{t('MindmapStudyPage.notFoundBody')}</p>
		{:else}
			<p class="status error" role="alert">{errorMessage}</p>
			<div class="retry-row">
				<button type="button" class="vc-btn secondary" onclick={load}>{t('Common.yenidenDene')}</button>
			</div>
		{/if}
	{:else if phase === 'ready' && mindmap}
		<h1>{mindmap.title}</h1>
		<!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
		<div class="map-frame" onclick={handleMapClick}>
			<svg bind:this={svgEl} class="mindmap-svg"></svg>
			<div class="map-controls">
				<button
					type="button"
					title={t('MindmapStudyPage.zoomIn')}
					aria-label={t('MindmapStudyPage.zoomIn')}
					disabled={!markmapInstance}
					onclick={() => markmapInstance?.rescale(ZOOM_STEP_IN)}
				>
					<ZoomInIcon size={16} strokeWidth={1.75} aria-hidden="true" />
				</button>
				<button
					type="button"
					title={t('MindmapStudyPage.zoomOut')}
					aria-label={t('MindmapStudyPage.zoomOut')}
					disabled={!markmapInstance}
					onclick={() => markmapInstance?.rescale(ZOOM_STEP_OUT)}
				>
					<ZoomOutIcon size={16} strokeWidth={1.75} aria-hidden="true" />
				</button>
				<button
					type="button"
					title={t('MindmapStudyPage.fitToScreen')}
					aria-label={t('MindmapStudyPage.fitToScreen')}
					disabled={!markmapInstance}
					onclick={() => markmapInstance?.fit()}
				>
					<MaximizeIcon size={16} strokeWidth={1.75} aria-hidden="true" />
				</button>
			</div>
		</div>
		<p class="map-hint">{t('MindmapStudyPage.mapHint')}</p>

		<h2>{t('MindmapStudyPage.sourcesTitle')}</h2>
		<div class="citations">
			{#each nodes as node (node.id)}
				<div class="citation-row">
					<span class="node-path">{node.path.join(' › ')}</span>
					<a class="source-link" href={libraryViewerUrl(node.source_path, data.vaultId ?? '', here)}>
						{node.source_path}
					</a>
					<a class="source-link" href={libraryViewerUrl(node.source_path, data.vaultId ?? '', here)} title={t('Common.kaynagiAc')} aria-label={t('Common.kaynagiAc')}>
						<ExternalLinkIcon size={16} strokeWidth={1.75} aria-hidden="true" />
					</a>
				</div>
			{/each}
		</div>
	{/if}
	{#snippet failed(error)}
		<p class="status error" role="alert">
			{t('MindmapStudyPage.viewFailed', { error: error instanceof Error ? error.message : String(error) })}
		</p>
	{/snippet}
	</svelte:boundary>
</div>

<style>
	.mindmap-screen {
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
		margin: 0 0 1rem;
	}

	.map-frame {
		position: relative;
	}

	.mindmap-svg {
		width: 100%;
		height: 60vh;
		box-shadow: inset 0 0 0 1px var(--separator);
		border-radius: var(--radius-lg);
		background: var(--bg-canvas);
		display: block;
	}

	.map-controls {
		position: absolute;
		top: 0.6rem;
		inset-inline-end: 0.6rem;
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}

	.map-controls button {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 1.85rem;
		height: 1.85rem;
		box-shadow: inset 0 0 0 1px var(--separator);
		border-radius: var(--radius-md);
		background: var(--bg-canvas);
		color: var(--label-secondary);
		cursor: pointer;
	}

	.map-controls button:hover:not(:disabled) {
		color: var(--label);
		background: var(--fill-hover);
	}

	.map-controls button:disabled {
		opacity: 0.4;
		cursor: default;
	}

	.map-controls button:focus-visible {
		outline: 2px solid var(--focus-ring);
		outline-offset: 1px;
	}

	.map-hint {
		margin: 0.4rem 0 0;
		font-size: 0.72rem;
		color: var(--label-secondary);
	}

	/* markmap-view injects its own `.markmap { --markmap-text-color: #333;
	   color: var(--markmap-text-color) }` rule directly onto this <svg>
	   (see markmap-view's index.js, `svg.attr('class', 'markmap ...')`) and
	   ships a `.markmap-dark .markmap` override that nothing in this app
	   ever applies — so node labels stayed dark-gray-on-dark and were
	   unreadable in dark mode. `:global(...)` is required on the
	   `[data-theme='dark']` ancestor part only: it's set on
	   <html> (+layout.svelte), outside this component's own markup, while
	   `.mindmap-svg` itself stays scoped since Svelte already recognizes it
	   from the template above. */
	/* Bubble styling for the explanation nodes. :global because markmap builds
	   this DOM itself and it never carries Svelte's scope hash — the same
	   reason the dark-theme block below is written this way. The markup comes
	   from mindmap-tree.ts's summaryMarkup(). */
	.mindmap-svg :global(.mm-summary) {
		display: block;
		padding: 0.3rem 0.5rem;
		border-radius: var(--radius-md);
		background: var(--bg-sidebar);
		color: var(--label-secondary);
		line-height: 1.45;
	}

	/* Exactly one variant is in the layout at a time. display:none is
	   load-bearing: markmap measures nodes with scrollWidth/scrollHeight, and a
	   CSS-clipped element still reports its full size — a clamp would make the
	   node reserve space for text nobody can see. */
	.mindmap-svg :global(.mm-summary.is-clamped) {
		cursor: pointer;
	}

	.mindmap-svg :global(.mm-summary.is-clamped .mm-full),
	.mindmap-svg :global(.mm-summary.is-expanded .mm-short) {
		display: none;
	}

	.mindmap-svg :global(.mm-summary.is-expanded) {
		cursor: pointer;
		background: var(--fill-control);
	}

	:global([data-theme='dark']) .mindmap-svg,
	:global([data-theme='forest']) .mindmap-svg {
		--markmap-text-color: var(--label);
		--markmap-code-bg: var(--bg-sidebar);
		--markmap-code-color: var(--label);
		--markmap-circle-open-bg: var(--bg-sidebar);
		--markmap-a-color: var(--label);
		--markmap-a-hover-color: var(--label);
	}

	h2 {
		font-size: 1rem;
		margin: 1.75rem 0 0.75rem;
	}

	.citations {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.citation-row {
		display: flex;
		align-items: baseline;
		gap: 0.6rem;
		flex-wrap: wrap;
		font-size: 0.85rem;
	}

	.node-path {
		color: var(--label-secondary);
		min-width: 200px;
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
