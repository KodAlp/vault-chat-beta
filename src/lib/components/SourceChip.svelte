<script lang="ts">
	import { obsidianUri, libraryViewerUrl } from '$lib/sourceLink';
	import type { RetrievedChunk } from '$lib/types';
	import * as HoverCard from '$lib/components/ui/hover-card';
	import ExternalLinkIcon from '@lucide/svelte/icons/external-link';
	import { t } from '$lib/i18n/index.svelte';

	/** Replaces SourceList.svelte — that component deduped on `path +
	 * heading_path`, so the same source cited from three chunks rendered as
	 * three separate chips (Faz 9 Adım 6 bug list). This dedupes on `path`
	 * alone and folds the count into a "×n bölüm" suffix instead. */
	let { sources, vaultId }: { sources: RetrievedChunk[]; vaultId: string } = $props();

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
							<a class="chip" href={libraryViewerUrl(g.path, vaultId)}>
								{g.topic}
								{#if g.chunks.length > 1}<span class="count">{t('SourceChip.chunkCount', { count: g.chunks.length })}</span>{/if}
							</a>
							<a class="chip-icon" href={obsidianUri(g.path)} title={t('Common.obsidiandaAc')} aria-label={t('Common.obsidiandaAc')}>
								<ExternalLinkIcon size={12} aria-hidden="true" />
							</a>
						</span>
					{/snippet}
				</HoverCard.Trigger>
				<HoverCard.Content class="w-72 text-xs">
					<p class="preview-title">{g.path}</p>
					<ul class="preview-list">
						{#each g.chunks as c, i (c.heading_path + '#' + i)}
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
		border: 1px solid var(--color-border);
		border-radius: var(--radius-pill);
		overflow: hidden;
	}

	.chip {
		font-size: 0.75rem;
		text-decoration: none;
		background: var(--color-muted);
		color: var(--color-muted-foreground);
		padding: 0.2rem 0.65rem;
	}

	.chip:hover {
		color: var(--color-primary);
	}

	.chip:focus-visible,
	.chip-icon:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: -2px;
	}

	.count {
		opacity: 0.7;
		margin-left: 0.15rem;
	}

	.chip-icon {
		display: inline-flex;
		align-items: center;
		text-decoration: none;
		background: var(--color-muted);
		color: var(--color-muted-foreground);
		padding: 0.2rem 0.5rem;
		border-left: 1px solid var(--color-border);
	}

	.chip-icon:hover {
		color: var(--color-primary);
	}

	.preview-title {
		font-weight: 600;
		margin: 0 0 0.35rem;
		word-break: break-all;
	}

	.preview-list {
		margin: 0;
		padding-left: 1rem;
		color: var(--color-muted-foreground);
	}

	.preview-list li {
		margin: 0.1rem 0;
	}
</style>
