<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { buildTree, treeToMarkdownOutline } from '$lib/mindmap-tree';
	import { obsidianUri, libraryViewerUrl } from '$lib/sourceLink';
	import type { PageProps } from './$types';
	import type { MindMapNodeView, MindMapView } from '$lib/types';
	import ExternalLinkIcon from '@lucide/svelte/icons/external-link';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';

	let { data }: PageProps = $props();

	type Phase = 'loading' | 'ready' | 'error';

	let phase = $state<Phase>('loading');
	let mindmap = $state<MindMapView | null>(null);
	let nodes = $state<MindMapNodeView[]>([]);
	let errorMessage = $state('');
	let svgEl = $state<SVGSVGElement | undefined>(undefined);
	let markmapInstance: { destroy(): void } | undefined;

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
			const tree = buildTree(mindmap.title, nodes);
			const outline = treeToMarkdownOutline(tree);
			const { root } = new Transformer().transform(outline);
			if (svgEl) {
				markmapInstance = Markmap.create(svgEl, undefined, root);
			}
		} catch {
			errorMessage = 'Zihin haritası yüklenemedi.';
			phase = 'error';
		}
	});

	onDestroy(() => {
		markmapInstance?.destroy();
	});
</script>

<svelte:head>
	<title>{mindmap?.title ?? 'Zihin haritası'} — Vault Agent Toolkit</title>
</svelte:head>

<div class="mindmap-screen">
	<a class="home-link" href="/"><ArrowLeftIcon size={14} aria-hidden="true" /> Ana sayfa</a>

	{#if phase === 'loading'}
		<p class="status">Yükleniyor...</p>
	{:else if phase === 'error'}
		<p class="status error" role="alert">{errorMessage}</p>
	{:else if phase === 'ready' && mindmap}
		<h1>{mindmap.title}</h1>
		<svg bind:this={svgEl} class="mindmap-svg"></svg>

		<h2>Kaynaklar</h2>
		<div class="citations">
			{#each nodes as node (node.id)}
				<div class="citation-row">
					<span class="node-path">{node.path.join(' › ')}</span>
					<a class="source-link" href={libraryViewerUrl(node.source_path, data.vaultId ?? '')}>
						{node.source_path}
					</a>
					<a class="source-link" href={obsidianUri(node.source_path)} title="Obsidian'da aç" aria-label="Obsidian'da aç">
						<ExternalLinkIcon size={13} aria-hidden="true" />
					</a>
				</div>
			{/each}
		</div>
	{/if}
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

	.mindmap-svg {
		width: 100%;
		height: 60vh;
		border: 1px solid var(--color-border);
		border-radius: 10px;
		background: var(--color-background);
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
