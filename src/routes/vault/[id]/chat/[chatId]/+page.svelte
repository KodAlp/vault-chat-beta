<script lang="ts">
	import Chat from '$lib/components/Chat.svelte';
	import ExportMenu from '$lib/components/ExportMenu.svelte';
	import QuizDialog from '$lib/components/QuizDialog.svelte';
	import CardsDialog from '$lib/components/CardsDialog.svelte';
	import ReportDialog from '$lib/components/ReportDialog.svelte';
	import MindMapDialog from '$lib/components/MindMapDialog.svelte';
	import SlidesDialog from '$lib/components/SlidesDialog.svelte';
	import SourceTree from '$lib/components/SourceTree.svelte';
	import StudyPanel from '$lib/components/StudyPanel.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let leftCollapsed = $state(false);
	let includedPaths = $state<string[] | undefined>(undefined);
	let sourceCounts = $state({ selected: 0, total: 0 });
	let focusSignal = $state(0);
	let studyPanelOpen = $state(false);
	let quizOpen = $state(false);
	let cardsOpen = $state(false);
	let reportOpen = $state(false);
	let mindMapOpen = $state(false);
	let slidesOpen = $state(false);

	function handleChatLoaded(paths: string[] | undefined) {
		includedPaths = paths;
	}

	async function handleScopeChange(paths: string[] | undefined) {
		includedPaths = paths;
		try {
			// 404s harmlessly for a chat row that doesn't exist yet (brand new
			// chat, first message not sent) — the selection at send time still
			// reaches the server via /api/chat's own includedPaths field.
			await fetch(`/api/chats/${data.chatId}`, {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ includedPaths: paths ?? null })
			});
		} catch {
			// best-effort persistence — the in-memory selection still applies to this session
		}
	}

	function handleFocusTree() {
		leftCollapsed = false;
		focusSignal += 1;
	}
</script>

<svelte:head>
	<title>{data.vaultName} — Vault Chat</title>
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
			<a class="vault-name" href="/vault/{data.vaultId}" title="Sohbet listesine dön">
				← {data.vaultName}
			</a>
			<SourceTree
				vaultId={data.vaultId}
				{includedPaths}
				onSelectionChange={handleScopeChange}
				onCounts={(c) => (sourceCounts = c)}
				{focusSignal}
			/>
		{/if}
	</aside>

	<main class="panel-center">
		<Chat
			chatId={data.chatId}
			vaultId={data.vaultId}
			{includedPaths}
			selectedCount={sourceCounts.selected}
			totalCount={sourceCounts.total}
			onChatLoaded={handleChatLoaded}
			onExpandScope={() => handleScopeChange(undefined)}
			onFocusTree={handleFocusTree}
		/>
	</main>

	<aside class="panel-right">
		<div class="right-top">
			<a href="/?picker=1" title="Vault seçici">⌂</a>
			<ExportMenu chatId={data.chatId} />
			<a href="/settings" title="Ayarlar">⚙</a>
		</div>
		<div class="right-middle">
			<button
				type="button"
				class="study-panel-trigger"
				onclick={() => (studyPanelOpen = true)}
				title="Çalışma Paneli"
			>
				<span>📚</span>
				<span class="trigger-label">Panel</span>
			</button>
			<QuizDialog chatId={data.chatId} vaultId={data.vaultId} bind:open={quizOpen} />
			<CardsDialog chatId={data.chatId} vaultId={data.vaultId} bind:open={cardsOpen} />
			<ReportDialog chatId={data.chatId} vaultId={data.vaultId} bind:open={reportOpen} />
			<MindMapDialog chatId={data.chatId} vaultId={data.vaultId} bind:open={mindMapOpen} />
			<SlidesDialog chatId={data.chatId} vaultId={data.vaultId} bind:open={slidesOpen} />
		</div>
		<div class="right-bottom placeholder-text">Profil (yakında)</div>
	</aside>
</div>

<StudyPanel
	bind:open={studyPanelOpen}
	onOpenQuiz={() => (quizOpen = true)}
	onOpenCards={() => (cardsOpen = true)}
	onOpenReport={() => (reportOpen = true)}
	onOpenMindMap={() => (mindMapOpen = true)}
	onOpenSlides={() => (slidesOpen = true)}
/>

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

	.vault-name {
		display: block;
		font-size: 0.8rem;
		font-weight: 600;
		text-decoration: none;
		color: var(--foreground);
		margin-bottom: 0.6rem;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.vault-name:hover {
		color: var(--primary);
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

	.study-panel-trigger {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.25rem;
		border: none;
		background: transparent;
		color: var(--muted-foreground);
		cursor: pointer;
	}

	.study-panel-trigger:hover {
		color: var(--primary);
	}

	.trigger-label {
		font-size: 0.65rem;
	}

	.right-bottom {
		text-align: center;
		writing-mode: vertical-rl;
		font-size: 0.75rem;
	}
</style>
