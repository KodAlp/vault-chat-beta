<script lang="ts">
	import { obsidianUri, libraryViewerUrl } from '$lib/sourceLink';
	import type { RetrievedChunk } from '$lib/types';

	let { sources }: { sources: RetrievedChunk[] } = $props();
</script>

{#if sources.length > 0}
	<div class="sources">
		{#each sources as source (source.path + source.heading_path)}
			<span class="chip-group" title={source.heading_path}>
				<a class="chip" href={obsidianUri(source.path)}>{source.topic}</a>
				<a class="chip-icon" href={libraryViewerUrl(source.path)} title="Kütüphanede görüntüle">⇱</a>
			</span>
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
		background: var(--code-bg);
		color: var(--muted);
		padding: 0.2rem 0.65rem;
	}

	.chip:hover {
		color: var(--accent);
	}

	.chip-icon {
		font-size: 0.7rem;
		text-decoration: none;
		background: var(--code-bg);
		color: var(--muted);
		padding: 0.2rem 0.5rem;
		border-left: 1px solid var(--border);
	}

	.chip-icon:hover {
		color: var(--accent);
	}
</style>
