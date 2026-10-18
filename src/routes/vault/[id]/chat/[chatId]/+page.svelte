<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import Chat from '$lib/components/Chat.svelte';
	import ExportMenu from '$lib/components/ExportMenu.svelte';
	import QuizDialog from '$lib/components/QuizDialog.svelte';
	import CardsDialog from '$lib/components/CardsDialog.svelte';
	import ReportDialog from '$lib/components/ReportDialog.svelte';
	import MindMapDialog from '$lib/components/MindMapDialog.svelte';
	import SlidesDialog from '$lib/components/SlidesDialog.svelte';
	import SourcesSheet, { type SourceCounts } from '$lib/components/SourcesSheet.svelte';
	import SourceTrigger from '$lib/components/SourceTrigger.svelte';
	import ChatSidebar from '$lib/components/ChatSidebar.svelte';
	import AnimatedIcon from '$lib/components/AnimatedIcon.svelte';
	import StudyPanel from '$lib/components/StudyPanel.svelte';
	import { scopeExpandSignal } from '$lib/scope-expand.svelte';
	import { t } from '$lib/i18n/index.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let leftCollapsed = $state(false);
	// Set the moment the user manually toggles the panel — once true, the
	// resize listener below stops auto-managing collapse state, so a
	// deliberate choice (e.g. pinned open on a narrow window) never gets
	// silently reverted by a later resize.
	let userOverrodeCollapse = false;
	let includedPaths = $state<string[] | undefined>(undefined);
	let sourceCounts = $state<SourceCounts>({ selected: 0, total: 0, areasSelected: 0, areasTotal: 0 });
	let sourcesOpen = $state(false);
	// "<provider> · <model>" reported by Chat; shown in the sidebar's Kaynaklar card.
	let modelLabel = $state('');
	// Title of the open chat, reported by ChatSidebar from the chat list.
	let chatTitle = $state<string | null>(null);
	let sidebar: ReturnType<typeof ChatSidebar> | undefined = $state();
	let studyPanelOpen = $state(false);
	// StudyPanel owns the "unseen" computation (it has the data) but not the
	// trigger button that shows the dot (that lives here) — see
	// StudyPanel's onUnseenChange doc comment.
	let hasUnseenStudyItems = $state(false);
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

	// Chat's empty state asks to "go to the source tree" — the tree now
	// lives in the sources sheet, so that opens it.
	function handleFocusTree() {
		sourcesOpen = true;
	}

	// The generation-error toast lives in the root layout (routes/+layout.svelte),
	// which has no access to this page's own includedPaths state — it can only
	// fire a global "expand scope" signal (lib/scope-expand.svelte.ts), which
	// this page (the actual owner of the selection) reacts to here. Guarded by
	// a "last seen" value, not a bare truthy check: module-level $state
	// survives client-side navigation, so without this guard, navigating to a
	// brand new chat page after a past toast click (this session or an earlier
	// one) would immediately and spuriously clear that new chat's own scope.
	let lastSeenScopeExpand = scopeExpandSignal.value;
	$effect(() => {
		if (scopeExpandSignal.value !== lastSeenScopeExpand) {
			lastSeenScopeExpand = scopeExpandSignal.value;
			handleScopeChange(undefined);
		}
	});

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
	<title>{data.vaultName} — Vault Chat</title>
</svelte:head>

<div class="chat-screen vc-root">
	<ChatSidebar
		bind:this={sidebar}
		vaultId={data.vaultId}
		vaultName={data.vaultName}
		chatId={data.chatId}
		collapsed={leftCollapsed}
		ontoggle={toggleCollapse}
		onTitle={(title) => (chatTitle = title)}
		sourceCounts={sourceCounts}
		sourcesExpanded={sourcesOpen}
		{modelLabel}
		onOpenSources={() => (sourcesOpen = true)}
	/>

	<main class="panel-center">
		<header class="vc-titlebar" aria-label={t('ChatTitleBar.ariaLabel')}>
			<div class="heading">
				<div class="title" title={chatTitle ?? undefined}>{chatTitle ?? t('ChatSidebar.newChat')}</div>
				<div class="sub">{data.vaultName}</div>
			</div>
			<span class="spacer"></span>
			<a
				class="vc-icon-btn"
				href="/?picker=1"
				title={t('VaultChatPage.vaultPicker')}
				aria-label={t('VaultChatPage.vaultPicker')}
			><Icon name="house" /></a>
			<ExportMenu chatId={data.chatId} />
			<a
				class="vc-icon-btn"
				href="/settings"
				title={t('Common.ayarlar')}
				aria-label={t('Common.ayarlar')}
			><Icon name="settings" /></a>
			<button
				type="button"
				class="vc-icon-btn study-panel-trigger"
				aria-pressed={studyPanelOpen}
				onclick={() => (studyPanelOpen = true)}
				title={t('VaultChatPage.studyPanelTitle')}
				aria-label={t('VaultChatPage.studyPanelTitle')}
			>
				<AnimatedIcon name="panel-right" active={studyPanelOpen} />
				{#if hasUnseenStudyItems}
					<span class="unseen-dot" aria-hidden="true"></span>
					<span class="sr-only">{t('VaultChatPage.unseenContent')}</span>
				{/if}
			</button>
		</header>
		<div class="chat-host">
			<Chat
				chatId={data.chatId}
				vaultId={data.vaultId}
				{includedPaths}
				onChatLoaded={handleChatLoaded}
				onExpandScope={() => handleScopeChange(undefined)}
				onFocusTree={handleFocusTree}
				onTurnEnd={() => void sidebar?.refresh()}
				onModelLabel={(label) => (modelLabel = label)}
			>
				{#snippet composerStart()}
					<SourceTrigger
						selected={sourceCounts.selected}
						total={sourceCounts.total}
						areasSelected={sourceCounts.areasSelected}
						areasTotal={sourceCounts.areasTotal}
						expanded={sourcesOpen}
						onclick={() => (sourcesOpen = true)}
					/>
				{/snippet}
			</Chat>
		</div>
	</main>
</div>

<SourcesSheet
	bind:open={sourcesOpen}
	vaultId={data.vaultId}
	vaultName={data.vaultName}
	{includedPaths}
	onSelectionChange={handleScopeChange}
	onCounts={(c) => (sourceCounts = c)}
/>

<!-- The dialogs render their own rail-style trigger buttons; the StudyPanel rows
     open them now, so the triggers stay hidden (dialog content is portaled). -->
<div class="dialog-hosts" hidden>
	<QuizDialog chatId={data.chatId} vaultId={data.vaultId} {includedPaths} bind:open={quizOpen} />
	<CardsDialog chatId={data.chatId} vaultId={data.vaultId} {includedPaths} bind:open={cardsOpen} />
	<ReportDialog chatId={data.chatId} vaultId={data.vaultId} {includedPaths} bind:open={reportOpen} />
	<MindMapDialog chatId={data.chatId} vaultId={data.vaultId} {includedPaths} bind:open={mindMapOpen} />
	<SlidesDialog chatId={data.chatId} vaultId={data.vaultId} {includedPaths} bind:open={slidesOpen} />
</div>

<StudyPanel
	bind:open={studyPanelOpen}
	vaultId={data.vaultId}
	onOpenQuiz={() => (quizOpen = true)}
	onOpenCards={() => (cardsOpen = true)}
	onOpenReport={() => (reportOpen = true)}
	onOpenMindMap={() => (mindMapOpen = true)}
	onOpenSlides={() => (slidesOpen = true)}
	onUnseenChange={(v) => (hasUnseenStudyItems = v)}
/>

<style>
	.chat-screen {
		display: flex;
		height: 100%;
		background: var(--bg-canvas);
	}

	.panel-center {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
	}

	.vc-titlebar {
		position: sticky;
		top: 0;
		z-index: 10;
		flex-shrink: 0;
	}

	.heading {
		min-width: 0;
		max-width: 40%;
		padding-inline: var(--space-2);
	}

	.heading .title,
	.heading .sub {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.spacer {
		flex: 1;
	}

	.vc-titlebar a.vc-icon-btn {
		text-decoration: none;
	}

	.chat-host {
		flex: 1;
		min-height: 0;
		position: relative;
	}

	.study-panel-trigger {
		position: relative;
	}

	/* "there's generated material you haven't looked at yet"; disappears the
	   moment the panel is opened (StudyPanel's markSeen()). */
	.unseen-dot {
		position: absolute;
		top: 5px;
		inset-inline-end: 5px;
		width: 8px;
		height: 8px;
		border-radius: 999px;
		background: var(--success);
		box-shadow: 0 0 0 2px var(--bg-canvas);
	}
</style>
