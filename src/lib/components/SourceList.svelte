<script lang="ts">
	import { env } from '$env/dynamic/public';
	import type { RetrievedChunk } from '$lib/types';

	let { sources }: { sources: RetrievedChunk[] } = $props();
	const vaultName = env.PUBLIC_VAULT_NAME ?? '';

	function obsidianUri(path: string): string {
		const params = new URLSearchParams({ vault: vaultName, file: path.replace(/\.md$/, '') });
		return `obsidian://open?${params.toString()}`;
	}
</script>

{#if sources.length > 0}
	<div class="sources">
		{#each sources as source (source.path + source.heading_path)}
			<a class="chip" href={obsidianUri(source.path)} title={source.heading_path}>
				{source.topic}
			</a>
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

	.chip {
		font-size: 0.75rem;
		text-decoration: none;
		background: var(--code-bg);
		color: var(--muted);
		border: 1px solid var(--border);
		border-radius: 999px;
		padding: 0.2rem 0.65rem;
	}

	.chip:hover {
		color: var(--accent);
		border-color: var(--accent);
	}
</style>
