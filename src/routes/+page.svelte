<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import type { ChatSummary } from '$lib/types';
	import { setPendingMessage } from '$lib/pending-message';

	let chats = $state<ChatSummary[]>([]);
	let loadError = $state('');
	let question = $state('');

	onMount(refresh);

	async function refresh() {
		try {
			const res = await fetch('/api/chats');
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
		goto(`/chat/${chatId}`);
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
</script>

<svelte:head>
	<title>Vault Chat</title>
</svelte:head>

<div class="welcome">
	<a class="settings-link" href="/settings" title="Ayarlar">⚙</a>

	<h1>Vault Chat</h1>
	<p class="subtitle">Kasandaki notlar hakkında bir soru sor.</p>

	<div class="composer">
		<textarea
			id="welcome-input"
			name="welcome-input"
			bind:value={question}
			onkeydown={handleKeydown}
			placeholder="Bir soru yaz... (Enter: başlat, Shift+Enter: yeni satır)"
		></textarea>
		<button onclick={start} disabled={!question.trim()}>Başlat</button>
	</div>

	{#if chats.length > 0}
		<section class="recent">
			<h2>Son konuşmalar</h2>
			<ul>
				{#each chats as chat (chat.id)}
					<li>
						<a href="/chat/{chat.id}">
							<span class="title">{chat.title ?? '(başlıksız)'}</span>
							<span class="meta">{chat.model} · {formatDate(chat.updated_at)}</span>
						</a>
					</li>
				{/each}
			</ul>
		</section>
	{:else if loadError}
		<p class="warn">{loadError}</p>
	{/if}
</div>

<style>
	.welcome {
		max-width: 640px;
		margin: 0 auto;
		padding: 3rem 1rem;
		position: relative;
	}

	.settings-link {
		position: absolute;
		top: 1rem;
		right: 1rem;
		font-size: 1.2rem;
		text-decoration: none;
		color: var(--muted);
	}

	h1 {
		font-size: 1.6rem;
		margin: 0 0 0.25rem;
		text-align: center;
	}

	.subtitle {
		color: var(--muted);
		text-align: center;
		margin: 0 0 2rem;
	}

	.composer {
		display: flex;
		gap: 0.5rem;
		margin-bottom: 2.5rem;
	}

	textarea {
		flex: 1;
		resize: none;
		min-height: 3rem;
		max-height: 10rem;
		padding: 0.6rem 0.85rem;
		border-radius: 8px;
		border: 1px solid var(--border);
		background: var(--bg);
		color: var(--fg);
		font-family: var(--font-sans);
		font-size: 0.95rem;
	}

	button {
		padding: 0 1.1rem;
		border-radius: 8px;
		border: none;
		background: var(--accent);
		color: var(--accent-fg);
		font-weight: 600;
		cursor: pointer;
	}

	button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.recent h2 {
		font-size: 0.9rem;
		color: var(--muted);
		margin: 0 0 0.75rem;
		font-weight: 600;
	}

	.recent ul {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
	}

	.recent a {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		gap: 1rem;
		padding: 0.6rem 0.85rem;
		border-radius: 8px;
		border: 1px solid var(--border);
		text-decoration: none;
		color: var(--fg);
	}

	.recent a:hover {
		border-color: var(--accent);
	}

	.recent .title {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.recent .meta {
		flex-shrink: 0;
		font-size: 0.75rem;
		color: var(--muted);
	}

	.warn {
		color: var(--error);
		font-size: 0.85rem;
		text-align: center;
	}
</style>
