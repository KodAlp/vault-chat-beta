<script lang="ts">
	import { onMount } from 'svelte';
	import type { ChatSummary } from '$lib/types';

	let { onSelect }: { onSelect: (chatId: string) => void } = $props();

	let chats = $state<ChatSummary[]>([]);
	let loadError = $state('');

	async function refresh() {
		try {
			const res = await fetch('/api/chats');
			if (!res.ok) throw new Error();
			chats = (await res.json()) as ChatSummary[];
		} catch {
			loadError = 'Geçmiş alınamadı';
		}
	}

	onMount(refresh);

	function handleChange(e: Event) {
		const id = (e.target as HTMLSelectElement).value;
		(e.target as HTMLSelectElement).value = '';
		if (id) onSelect(id);
	}
</script>

<select id="chat-history" name="chat-history" onchange={handleChange} onfocus={refresh} title={loadError || 'Geçmiş konuşmalar'}>
	<option value="">Geçmiş...</option>
	{#each chats as c (c.id)}
		<option value={c.id}>{c.title ?? '(başlıksız)'}</option>
	{/each}
</select>

<style>
	select {
		background: var(--bg);
		color: var(--fg);
		border: 1px solid var(--border);
		border-radius: 6px;
		padding: 0.35rem 0.5rem;
		font-size: 0.9rem;
	}
</style>
