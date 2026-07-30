<script lang="ts">
	import Chat from '$lib/components/Chat.svelte';
	import ExportMenu from '$lib/components/ExportMenu.svelte';
	import QuizDialog from '$lib/components/QuizDialog.svelte';
	import CardsDialog from '$lib/components/CardsDialog.svelte';
	import ReportDialog from '$lib/components/ReportDialog.svelte';
	import MindMapDialog from '$lib/components/MindMapDialog.svelte';
	import SlidesDialog from '$lib/components/SlidesDialog.svelte';
	import LibraryTree from '$lib/components/LibraryTree.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let leftCollapsed = $state(false);
</script>

<svelte:head>
	<title>Vault Chat</title>
</svelte:head>

<div class="chat-screen">
	<aside class="panel-left" class:collapsed={leftCollapsed}>
		<button
			class="collapse-toggle"
			onclick={() => (leftCollapsed = !leftCollapsed)}
			title={leftCollapsed ? 'Paneli genişlet' : 'Paneli daralt'}
		>
			{leftCollapsed ? '»' : '«'}
		</button>
		{#if !leftCollapsed}
			<LibraryTree />
		{/if}
	</aside>

	<main class="panel-center">
		<Chat chatId={data.chatId} />
	</main>

	<aside class="panel-right">
		<div class="right-top">
			<a href="/" title="Ana sayfa">⌂</a>
			<ExportMenu chatId={data.chatId} />
			<a href="/settings" title="Ayarlar">⚙</a>
		</div>
		<div class="right-middle">
			<QuizDialog chatId={data.chatId} />
			<CardsDialog chatId={data.chatId} />
			<ReportDialog chatId={data.chatId} />
			<MindMapDialog chatId={data.chatId} />
			<SlidesDialog chatId={data.chatId} />
		</div>
		<div class="right-bottom placeholder-text">Profil (yakında)</div>
	</aside>
</div>

<style>
	.chat-screen {
		display: flex;
		height: 100dvh;
	}

	.panel-left,
	.panel-right {
		flex-shrink: 0;
		display: flex;
		flex-direction: column;
		border-color: var(--border);
	}

	.panel-left {
		width: 220px;
		border-right: 1px solid var(--border);
		padding: 0.75rem;
		transition: width 0.15s ease;
		min-height: 0;
	}

	.panel-left.collapsed {
		width: 2.5rem;
		padding: 0.75rem 0.4rem;
	}

	.collapse-toggle {
		align-self: flex-start;
		background: transparent;
		border: 1px solid var(--border);
		color: var(--muted-foreground);
		border-radius: 6px;
		width: 1.75rem;
		height: 1.75rem;
		padding: 0;
		cursor: pointer;
		margin-bottom: 0.75rem;
	}

	.placeholder-text {
		color: var(--muted-foreground);
		font-size: 0.85rem;
	}

	.panel-center {
		flex: 1;
		min-width: 0;
	}

	.panel-right {
		width: 3.5rem;
		border-left: 1px solid var(--border);
		align-items: center;
		justify-content: space-between;
		padding: 0.75rem 0;
	}

	.right-top {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.9rem;
	}

	.right-top a {
		text-decoration: none;
		color: var(--muted-foreground);
		font-size: 0.9rem;
	}

	.right-top a:hover {
		color: var(--primary);
	}

	.right-middle {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 1.1rem;
	}

	.right-bottom {
		text-align: center;
		writing-mode: vertical-rl;
		font-size: 0.75rem;
	}
</style>
