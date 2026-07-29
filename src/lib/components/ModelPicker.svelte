<script lang="ts">
	import { onMount } from 'svelte';
	import type { OllamaModel } from '$lib/types';

	let { model = $bindable() }: { model: string } = $props();

	let models = $state<OllamaModel[]>([]);
	let loadError = $state('');

	onMount(async () => {
		try {
			const res = await fetch('/api/models');
			if (!res.ok) throw new Error();
			models = (await res.json()) as OllamaModel[];
		} catch {
			loadError = 'Model listesi alınamadı — Ollama çalışıyor mu?';
		}
	});
</script>

<select id="model-picker" name="model-picker" bind:value={model} title={loadError || 'Model seç'}>
	{#if models.length === 0}
		<option value={model}>{model}</option>
	{/if}
	{#each models as m (m.name)}
		<option value={m.name}>{m.name}</option>
	{/each}
</select>

{#if loadError}
	<span class="warn">{loadError}</span>
{/if}

<style>
	select {
		background: var(--bg);
		color: var(--fg);
		border: 1px solid var(--border);
		border-radius: 6px;
		padding: 0.35rem 0.5rem;
		font-size: 0.9rem;
	}

	.warn {
		color: var(--error);
		font-size: 0.75rem;
		margin-left: 0.5rem;
	}
</style>
