<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import type { ChatSummary } from '$lib/types';
	import { setPendingMessage } from '$lib/pending-message';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import { Badge } from '$lib/components/ui/badge';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let chats = $state<ChatSummary[]>([]);
	let loadError = $state('');
	let question = $state('');

	onMount(refresh);

	async function refresh() {
		try {
			const res = await fetch(`/api/chats?vault=${encodeURIComponent(data.vaultId)}`);
			if (!res.ok) throw new Error();
			chats = (await res.json()) as ChatSummary[];
		} catch {
			loadError = 'Geçmiş alınamadı';
		}
	}

	function start() {
		const trimmed = question.trim();
		if (!trimmed) return;
		const chatId = crypto.randomUUID();
		setPendingMessage({ chatId, question: trimmed });
		goto(`/vault/${data.vaultId}/chat/${chatId}`);
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			start();
		}
	}

	function formatDate(iso: string): string {
		return new Date(iso).toLocaleString('tr-TR', {
			day: '2-digit',
			month: '2-digit',
			hour: '2-digit',
			minute: '2-digit'
		});
	}

	function scopeCount(json: string | null): number | null {
		if (!json) return null;
		try {
			const arr = JSON.parse(json) as unknown[];
			return Array.isArray(arr) ? arr.length : null;
		} catch {
			return null;
		}
	}
</script>

<svelte:head>
	<title>{data.vaultName} — Vault Chat</title>
</svelte:head>

<div class="mx-auto max-w-2xl px-4 pt-8 pb-12">
	<div class="mb-6 flex items-center justify-between">
		<a href="/?picker=1" class="text-sm text-muted-foreground hover:text-foreground">← Vault'lar</a>
		<h1 class="text-lg font-semibold">{data.vaultName}</h1>
		<a href="/settings" title="Ayarlar" class="text-lg text-muted-foreground hover:text-primary">⚙</a>
	</div>

	<Card.Root class="mb-6">
		<Card.Content class="flex gap-2">
			<textarea
				id="new-chat-input"
				name="new-chat-input"
				bind:value={question}
				onkeydown={handleKeydown}
				placeholder="Bir soru yaz... (Enter: başlat, Shift+Enter: yeni satır)"
				class="min-h-[3rem] max-h-40 flex-1 resize-none rounded-lg border bg-background px-3 py-2.5 text-sm outline-none placeholder:text-muted-foreground"
			></textarea>
			<Button onclick={start} disabled={!question.trim()}>Başlat</Button>
		</Card.Content>
	</Card.Root>

	{#if chats.length > 0}
		<div class="flex flex-col gap-2">
			{#each chats as chat (chat.id)}
				{@const n = scopeCount(chat.included_paths_json)}
				<a href="/vault/{data.vaultId}/chat/{chat.id}" class="block no-underline">
					<Card.Root class="transition-colors hover:border-primary">
						<Card.Content class="flex items-center justify-between gap-3">
							<span class="truncate text-sm text-foreground">{chat.title ?? '(başlıksız)'}</span>
							<span class="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
								{#if n !== null}
									<Badge variant="outline">{n} kaynak</Badge>
								{/if}
								{chat.model} · {formatDate(chat.updated_at)}
							</span>
						</Card.Content>
					</Card.Root>
				</a>
			{/each}
		</div>
	{:else if loadError}
		<p class="text-center text-sm text-destructive">{loadError}</p>
	{/if}
</div>
