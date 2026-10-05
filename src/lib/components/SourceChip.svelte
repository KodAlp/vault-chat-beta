<script lang="ts">
	import { page } from '$app/state';
	import { libraryViewerUrl } from '$lib/sourceLink';
	import type { RetrievedChunk } from '$lib/types';
	import * as HoverCard from '$lib/components/ui/hover-card';
	import ExternalLinkIcon from '@lucide/svelte/icons/external-link';
	import { t } from '$lib/i18n/index.svelte';
	import { setHighlight, clearHighlight } from '$lib/source-highlight.svelte';

	let here = $derived(page.url.pathname + page.url.search);

	/**
	 * Citation → source-tree focal moment (Task 6): hovering/focusing a chip
	 * lights up that file's row in the left panel's source tree. A single
	 * shared timer (not one per chip) is enough — only one pointer can be
	 * hovering at a time, and a fresh pointerenter always clears whatever
	 * timer came before it, so sweeping across several chips never lets a
	 * stale ~120ms intent-delay fire for a chip the pointer already left.
	 */
	let hoverTimer: ReturnType<typeof setTimeout> | undefined;
	// The path this component last lit, so unmounting mid-hover (e.g.
	// navigating away) doesn't leave a stale highlight in the shared store.
	let litPath: string | null = null;

	function scheduleHighlight(path: string) {
		clearTimeout(hoverTimer);
		hoverTimer = setTimeout(() => {
			litPath = path;
			setHighlight(path);
		}, 120);
	}

	function cancelScheduledHighlight(path: string) {
		clearTimeout(hoverTimer);
		hoverTimer = undefined;
		clearHighlight(path);
	}

	function focusHighlight(path: string) {
		clearTimeout(hoverTimer);
		hoverTimer = undefined;
		litPath = path;
		setHighlight(path);
	}

	$effect(() => {
		return () => {
			clearTimeout(hoverTimer);
			if (litPath) clearHighlight(litPath);
		};
	});

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
						<span
							{...props}
							class="chip-group"
							onpointerenter={() => scheduleHighlight(g.path)}
							onpointerleave={() => cancelScheduledHighlight(g.path)}
							onfocusin={() => focusHighlight(g.path)}
							onfocusout={() => cancelScheduledHighlight(g.path)}
						>
							<a class="vc-chip chip" href={libraryViewerUrl(g.path, vaultId, here)}>
								{g.topic}
								{#if g.chunks.length > 1}<span class="n count">{t('SourceChip.chunkCount', { count: g.chunks.length })}</span>{/if}
							</a>
							<a class="vc-icon-btn chip-icon" href={libraryViewerUrl(g.path, vaultId, here)} title={t('Common.kaynagiAc')} aria-label={t('Common.kaynagiAc')}>
								<ExternalLinkIcon size={16} strokeWidth={1.75} aria-hidden="true" />
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
		gap: var(--space-2);
	}

	.chip-group {
		display: inline-flex;
		align-items: center;
		gap: 2px;
	}

	.chip {
		text-decoration: none;
		max-width: 28ch;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.chip-icon {
		width: 28px;
		height: 28px;
		text-decoration: none;
	}

	.chip:focus-visible,
	.chip-icon:focus-visible {
		outline: 2px solid var(--focus-ring);
		outline-offset: 2px;
	}

	.count {
		margin-inline-start: 0.15rem;
	}

	.preview-title {
		font-weight: 600;
		margin: 0 0 0.35rem;
		word-break: break-all;
	}

	.preview-list {
		margin: 0;
		padding-inline-start: 1rem;
		color: var(--label-secondary);
	}

	.preview-list li {
		margin: 0.1rem 0;
	}
</style>
