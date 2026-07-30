<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { buildTree, treeToMarkdownOutline } from '$lib/mindmap-tree';
	import { obsidianUri, libraryViewerUrl } from '$lib/sourceLink';
	import type { PageProps } from './$types';
	import type { MindMapNodeView, MindMapView } from '$lib/types';

	let { data }: PageProps = $props();

	type Phase = 'loading' | 'ready' | 'error';

	let phase = $state<Phase>('loading');
	let mindmap = $state<MindMapView | null>(null);
	let nodes = $state<MindMapNodeView[]>([]);
	let errorMessage = $state('');
	let svgEl = $state<SVGSVGElement | undefined>(undefined);
	let markmapInstance: { destroy(): void } | undefined;

	onMount(async () => {
		try {
			const res = await fetch(`/api/study/mindmaps/${data.mindmapId}`);
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
	<title>{mindmap?.title ?? 'Zihin haritası'} — Vault Chat</title>
</svelte:head>

<div class="mindmap-screen">
	<a class="home-link" href="/">← Ana sayfa</a>

	{#if phase === 'loading'}
		<p class="status">Yükleniyor...</p>
	{:else if phase === 'error'}
		<p class="status error">{errorMessage}</p>
	{:else if phase === 'ready' && mindmap}
		<h1>{mindmap.title}</h1>
		<svg bind:this={svgEl} class="mindmap-svg"></svg>

		<h2>Kaynaklar</h2>
		<div class="citations">
			{#each nodes as node (node.id)}
				<div class="citation-row">
					<span class="node-path">{node.path.join(' › ')}</span>
					<a class="source-link" href={obsidianUri(node.source_path)} title="Obsidian'da aç">
						{node.source_path}
					</a>
					<a class="source-link" href={libraryViewerUrl(node.source_path)} title="Kütüphanede görüntüle">
						⇱
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
		display: inline-block;
		font-size: 0.9rem;
		text-decoration: none;
		margin-bottom: 1.5rem;
	}

	.status {
		color: var(--muted);
		text-align: center;
		margin-top: 3rem;
	}

	.status.error {
		color: var(--error);
	}

	h1 {
		font-size: 1.4rem;
		margin: 0 0 1rem;
	}

	.mindmap-svg {
		width: 100%;
		height: 60vh;
		border: 1px solid var(--border);
		border-radius: 10px;
		background: var(--bg);
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
		color: var(--muted);
		min-width: 200px;
	}

	.source-link {
		font-size: 0.75rem;
		color: var(--muted);
		text-decoration: none;
		border: 1px solid var(--border);
		border-radius: 999px;
		padding: 0.2rem 0.65rem;
	}

	.source-link:hover {
		color: var(--accent);
		border-color: var(--accent);
	}
</style>
