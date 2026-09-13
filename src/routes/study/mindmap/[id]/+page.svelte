<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { buildTree, treeToMarkdownOutline } from '$lib/mindmap-tree';
	import { libraryViewerUrl } from '$lib/sourceLink';
	import type { PageProps } from './$types';
	import type { MindMapNodeView, MindMapView } from '$lib/types';
	import ExternalLinkIcon from '@lucide/svelte/icons/external-link';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import ZoomInIcon from '@lucide/svelte/icons/zoom-in';
	import ZoomOutIcon from '@lucide/svelte/icons/zoom-out';
	import MaximizeIcon from '@lucide/svelte/icons/maximize';

	let { data }: PageProps = $props();

	type Phase = 'loading' | 'ready' | 'error';

	let phase = $state<Phase>('loading');
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

	onMount(async () => {
		try {
			const res = await fetch(`/api/study/mindmaps/${data.mindmapId}${mindmapQuery}`);
			if (!res.ok) throw new Error();
			const body = (await res.json()) as { mindmap: MindMapView; nodes: MindMapNodeView[] };
			mindmap = body.mindmap;
			nodes = body.nodes;
			if (nodes.length === 0) {
				errorMessage = 'Bu haritada düğüm yok.';
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
				node.sourcePath ? libraryViewerUrl(node.sourcePath, vaultId) : null
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
		} catch {
			errorMessage = 'Zihin haritası yüklenemedi.';
			phase = 'error';
		}
	});

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
	<title>{mindmap?.title ?? 'Zihin haritası'} — Vault Agent Toolkit</title>
</svelte:head>

<div class="mindmap-screen">
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
	{:else if phase === 'ready' && mindmap}
		<h1>{mindmap.title}</h1>
		<!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
		<div class="map-frame" onclick={handleMapClick}>
			<svg bind:this={svgEl} class="mindmap-svg"></svg>
			<div class="map-controls">
				<button
					type="button"
					title="Yakınlaştır"
					aria-label="Yakınlaştır"
					disabled={!markmapInstance}
					onclick={() => markmapInstance?.rescale(ZOOM_STEP_IN)}
				>
					<ZoomInIcon size={15} aria-hidden="true" />
				</button>
				<button
					type="button"
					title="Uzaklaştır"
					aria-label="Uzaklaştır"
					disabled={!markmapInstance}
					onclick={() => markmapInstance?.rescale(ZOOM_STEP_OUT)}
				>
					<ZoomOutIcon size={15} aria-hidden="true" />
				</button>
				<button
					type="button"
					title="Ekrana sığdır"
					aria-label="Ekrana sığdır"
					disabled={!markmapInstance}
					onclick={() => markmapInstance?.fit()}
				>
					<MaximizeIcon size={15} aria-hidden="true" />
				</button>
			</div>
		</div>
		<p class="map-hint">Bir düğümün dairesine tıklayarak aç/kapa; kısaltılmış açıklamaya tıklayarak tamamını gör.</p>

		<h2>Kaynaklar</h2>
		<div class="citations">
			{#each nodes as node (node.id)}
				<div class="citation-row">
					<span class="node-path">{node.path.join(' › ')}</span>
					<a class="source-link" href={libraryViewerUrl(node.source_path, data.vaultId ?? '')}>
						{node.source_path}
					</a>
					<a class="source-link" href={libraryViewerUrl(node.source_path, data.vaultId ?? '')} title="Kaynağı aç" aria-label="Kaynağı aç">
						<ExternalLinkIcon size={13} aria-hidden="true" />
					</a>
				</div>
			{/each}
		</div>
	{/if}
	{#snippet failed(error)}
		<p class="status error" role="alert">
			Zihin haritası görüntülenemedi: {error instanceof Error ? error.message : String(error)}
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
		margin: 0 0 1rem;
	}

	.map-frame {
		position: relative;
	}

	.mindmap-svg {
		width: 100%;
		height: 60vh;
		border: 1px solid var(--color-border);
		border-radius: 10px;
		background: var(--color-background);
		display: block;
	}

	.map-controls {
		position: absolute;
		top: 0.6rem;
		right: 0.6rem;
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
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		background: var(--color-background);
		color: var(--color-muted-foreground);
		cursor: pointer;
	}

	.map-controls button:hover:not(:disabled) {
		color: var(--color-primary);
		border-color: var(--color-primary);
	}

	.map-controls button:disabled {
		opacity: 0.4;
		cursor: default;
	}

	.map-controls button:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}

	.map-hint {
		margin: 0.4rem 0 0;
		font-size: 0.72rem;
		color: var(--color-muted-foreground);
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
		border-radius: 8px;
		background: var(--color-muted);
		color: var(--color-muted-foreground);
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
		background: var(--color-secondary);
	}

	:global([data-theme='dark']) .mindmap-svg {
		--markmap-text-color: var(--color-foreground);
		--markmap-code-bg: var(--color-muted);
		--markmap-code-color: var(--color-foreground);
		--markmap-circle-open-bg: var(--color-muted);
		--markmap-a-color: var(--color-primary);
		--markmap-a-hover-color: var(--color-primary);
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
		color: var(--color-muted-foreground);
		min-width: 200px;
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
