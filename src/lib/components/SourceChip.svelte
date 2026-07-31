<script lang="ts">
	import { obsidianUri, libraryViewerUrl } from '$lib/sourceLink';
	import type { RetrievedChunk } from '$lib/types';
	import * as HoverCard from '$lib/components/ui/hover-card';

	/** Replaces SourceList.svelte — that component deduped on `path +
	 * heading_path`, so the same source cited from three chunks rendered as
	 * three separate chips (Faz 9 Adım 6 bug list). This dedupes on `path`
	 * alone and folds the count into a "×n bölüm" suffix instead. */
	let { sources }: { sources: RetrievedChunk[] } = $props();

	interface GroupedSource {
		path: string;
		topic: string;
		chunks: RetrievedChunk[];
	}

	let grouped = $derived.by((): GroupedSource[] => {
		const byPath = new Map<string, GroupedSource>();
		for (const s of sources) {
			let g = byPath.get(s.path);
			if (!g) {
				g = { path: s.path, topic: s.topic, chunks: [] };
				byPath.set(s.path, g);
			}
			g.chunks.push(s);
		}
		return [...byPath.values()];
	});
</script>

{#if grouped.length > 0}
	<div class="sources">
		{#each grouped as g (g.path)}
			<HoverCard.Root openDelay={200}>
				<HoverCard.Trigger>
					{#snippet child({ props })}
						<span {...props} class="chip-group">
							<a class="chip" href={obsidianUri(g.path)}>
								{g.topic}
								{#if g.chunks.length > 1}<span class="count">×{g.chunks.length} bölüm</span>{/if}
							</a>
							<a class="chip-icon" href={libraryViewerUrl(g.path)} title="Kütüphanede görüntüle">⇱</a>
						</span>
					{/snippet}
				</HoverCard.Trigger>
				<HoverCard.Content class="w-72 text-xs">
					<p class="preview-title">{g.path}</p>
					<ul class="preview-list">
						{#each g.chunks as c (c.heading_path)}
							<li>{c.heading_path}</li>
						{/each}
					</ul>
				</HoverCard.Content>
			</HoverCard.Root>
		{/each}
	</div>
{/if}

<style>
	.sources {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
		margin-top: 0.5rem;
	}

	.chip-group {
		display: inline-flex;
		align-items: stretch;
		border: 1px solid var(--border);
		border-radius: 999px;
		overflow: hidden;
	}

	.chip {
		font-size: 0.75rem;
		text-decoration: none;
		background: var(--muted);
		color: var(--muted-foreground);
		padding: 0.2rem 0.65rem;
	}

	.chip:hover {
		color: var(--primary);
	}

	.count {
		opacity: 0.7;
		margin-left: 0.15rem;
	}

	.chip-icon {
		font-size: 0.7rem;
		text-decoration: none;
		background: var(--muted);
		color: var(--muted-foreground);
		padding: 0.2rem 0.5rem;
		border-left: 1px solid var(--border);
	}

	.chip-icon:hover {
		color: var(--primary);
	}

	.preview-title {
		font-weight: 600;
		margin: 0 0 0.35rem;
		word-break: break-all;
	}

	.preview-list {
		margin: 0;
		padding-left: 1rem;
		color: var(--muted-foreground);
	}

	.preview-list li {
		margin: 0.1rem 0;
	}
</style>
