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
	import HomeIcon from '@lucide/svelte/icons/house';
	import SettingsIcon from '@lucide/svelte/icons/settings';
	import LibraryIcon from '@lucide/svelte/icons/library';
	import PanelLeftCloseIcon from '@lucide/svelte/icons/panel-left-close';
	import PanelLeftOpenIcon from '@lucide/svelte/icons/panel-left-open';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let leftCollapsed = $state(false);
	// Set the moment the user manually toggles the panel — once true, the
	// resize listener below stops auto-managing collapse state, so a
	// deliberate choice (e.g. pinned open on a narrow window) never gets
	// silently reverted by a later resize.
	let userOverrodeCollapse = false;
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

	function toggleCollapse() {
		leftCollapsed = !leftCollapsed;
		userOverrodeCollapse = true;
	}

	// Default-collapsed below ~900px so the fixed-width tree doesn't eat the
	// transcript column on a laptop-width window — a live matchMedia
	// listener, not a one-time mount check, so resizing the window (a normal
	// action in a desktop Tauri window) keeps it correct, not just the
	// initial load width. Stops applying the moment the user manually
	// toggles the panel, so it never fights that choice afterward.
	$effect(() => {
		const mql = window.matchMedia('(max-width: 899px)');
		const apply = () => {
			if (userOverrodeCollapse) return;
			leftCollapsed = mql.matches;
		};
		apply();
		mql.addEventListener('change', apply);
		return () => mql.removeEventListener('change', apply);
	});
</script>

<svelte:head>
	<title>{data.vaultName} — Vault Agent Toolkit</title>
</svelte:head>

<div class="chat-screen">
	<aside class="panel-left" class:collapsed={leftCollapsed}>
		<button
			class="collapse-toggle"
			onclick={toggleCollapse}
			title={leftCollapsed ? 'Paneli genişlet' : 'Paneli daralt'}
			aria-label={leftCollapsed ? 'Paneli genişlet' : 'Paneli daralt'}
		>
			{#if leftCollapsed}
				<PanelLeftOpenIcon size={16} aria-hidden="true" />
			{:else}
				<PanelLeftCloseIcon size={16} aria-hidden="true" />
			{/if}
		</button>
		{#if !leftCollapsed}
			<a class="vault-name" href="/vault/{data.vaultId}" title="Sohbet listesine dön">
				<ArrowLeftIcon size={13} aria-hidden="true" />
				{data.vaultName}
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
			<a href="/?picker=1" title="Vault seçici" aria-label="Vault seçici"><HomeIcon size={17} aria-hidden="true" /></a>
			<ExportMenu chatId={data.chatId} />
			<a href="/settings" title="Ayarlar" aria-label="Ayarlar"><SettingsIcon size={17} aria-hidden="true" /></a>
		</div>
		<div class="right-middle">
			<button
				type="button"
				class="study-panel-trigger"
				onclick={() => (studyPanelOpen = true)}
				title="Çalışma Paneli"
			>
				<LibraryIcon size={19} aria-hidden="true" />
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
		height: 100%;
	}

	.panel-left,
	.panel-right {
		flex-shrink: 0;
		display: flex;
		flex-direction: column;
		border-color: var(--color-border);
	}

	.panel-left {
		width: 220px;
		border-right: 1px solid var(--color-border);
		padding: 0.75rem;
		/* Evaluated under /impeccable animate, deliberately kept as a width
		   transition rather than converted to transform: this collapse
		   reflows exactly one sibling (.panel-center, a simple flex:1 child)
		   — the cheap, common case the "don't animate width" rule exists to
		   distinguish from (a deep or repeatedly-nested layout recalculating
		   every frame). A transform-based slide would either leave a gap
		   where .panel-center doesn't reflow, or need the panel pulled out
		   of flow entirely — real added complexity for a two-child layout
		   that measures fine as-is. */
		transition: width var(--motion-fast) var(--motion-easing);
		min-height: 0;
	}

	.panel-left.collapsed {
		width: 2.5rem;
		padding: 0.75rem 0.4rem;
	}

	.collapse-toggle {
		align-self: flex-start;
		display: flex;
		align-items: center;
		justify-content: center;
		background: transparent;
		border: 1px solid var(--color-border);
		color: var(--color-muted-foreground);
		border-radius: var(--radius-sm);
		width: 1.75rem;
		height: 1.75rem;
		padding: 0;
		cursor: pointer;
		margin-bottom: 0.75rem;
	}

	.collapse-toggle:hover {
		color: var(--color-primary);
		border-color: var(--color-primary);
	}

	.collapse-toggle:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}

	.vault-name {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		font-size: 0.8rem;
		font-weight: 600;
		text-decoration: none;
		color: var(--color-foreground);
		margin-bottom: 0.6rem;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.vault-name:hover {
		color: var(--color-primary);
	}

	.vault-name:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}

	.placeholder-text {
		color: var(--color-muted-foreground);
		font-size: 0.85rem;
	}

	.panel-center {
		flex: 1;
		min-width: 0;
	}

	.panel-right {
		width: 3.5rem;
		border-left: 1px solid var(--color-border);
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
		display: flex;
		/* Padding brings the ~17px icon glyph up to the 24px WCAG 2.5.8 (AA)
		   touch-target floor without changing the icon's visual size. */
		padding: 0.25rem;
		margin: -0.25rem;
		text-decoration: none;
		color: var(--color-muted-foreground);
		border-radius: var(--radius-sm);
	}

	.right-top a:hover {
		color: var(--color-primary);
	}

	.right-top a:focus-visible,
	.study-panel-trigger:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
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
		color: var(--color-muted-foreground);
		cursor: pointer;
	}

	.study-panel-trigger:hover {
		color: var(--color-primary);
	}

	.trigger-label {
		font-size: 0.6875rem;
	}

	.right-bottom {
		text-align: center;
		writing-mode: vertical-rl;
		font-size: 0.75rem;
	}
</style>
