<script lang="ts">
	import { goto } from '$app/navigation';
	import { tick, onMount } from 'svelte';
	import type { ChatSummary } from '$lib/types';
	import { groupChatsByDate } from '$lib/chat-groups';
	import { t } from '$lib/i18n/index.svelte';
	import Icon from './Icon.svelte';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import PanelLeftCloseIcon from '@lucide/svelte/icons/panel-left-close';
	import PanelLeftOpenIcon from '@lucide/svelte/icons/panel-left-open';

	/**
	 * Chat-history sidebar (Sidebar.html): vault name + collapse toggle, a
	 * "new chat" button and the vault's chats grouped by date. Loads from the
	 * same /api/chats endpoint the vault page uses. A brand-new chat has no
	 * row until its first message is sent (Chat.svelte creates it
	 * server-side and does not tell the page), so while the open chat is
	 * missing from the list the sidebar shows a placeholder row for it and
	 * re-polls a few times. `refresh()` is exported for a future direct hook
	 * from Chat.
	 */
	let {
		vaultId,
		vaultName,
		chatId,
		collapsed = false,
		ontoggle,
		onTitle
	}: {
		vaultId: string;
		vaultName: string;
		chatId: string;
		collapsed?: boolean;
		ontoggle: () => void;
		/** Reports the open chat's title (null until it has a row/title). */
		onTitle?: (title: string | null) => void;
	} = $props();

	let chats = $state<ChatSummary[]>([]);
	let loadError = $state(false);

	const RETRY_MS = 2500;
	const MAX_RETRIES = 8;
	let retryTimer: ReturnType<typeof setTimeout> | undefined;

	let current = $derived(chats.find((c) => c.id === chatId));
	let groups = $derived(groupChatsByDate(chats));

	$effect(() => {
		onTitle?.(current ? (current.title ?? null) : null);
	});

	export async function refresh(): Promise<void> {
		try {
			const res = await fetch('/api/chats?vault=' + encodeURIComponent(vaultId));
			if (!res.ok) throw new Error();
			chats = (await res.json()) as ChatSummary[];
			loadError = false;
		} catch {
			loadError = true;
		}
	}

	// Re-runs per open chat; keeps polling briefly until its row shows up
	// (first message creates it) or gives up.
	$effect(() => {
		const id = chatId;
		void vaultId;
		let tries = 0;
		let cancelled = false;
		clearTimeout(retryTimer);
		const tickLoad = async () => {
			await refresh();
			if (cancelled) return;
			if (!chats.some((c) => c.id === id) && tries < MAX_RETRIES) {
				tries += 1;
				retryTimer = setTimeout(tickLoad, RETRY_MS);
			}
		};
		void tickLoad();
		return () => {
			cancelled = true;
			clearTimeout(retryTimer);
		};
	});

	onMount(() => {
		const onFocus = () => void refresh();
		window.addEventListener('focus', onFocus);
		return () => window.removeEventListener('focus', onFocus);
	});

	async function newChat() {
		// Same entry point as the vault page: a chat only comes into being
		// with its first message, typed in that page's composer.
		await goto('/vault/' + vaultId);
		await tick();
		document.getElementById('new-chat-input')?.focus();
	}

	function label(c: ChatSummary): string {
		return c.title ?? t('ChatSidebar.untitled');
	}

	function groupLabel(key: string): string {
		return t('ChatSidebar.' + key);
	}
</script>

<aside class="vc-sidebar chat-sidebar" class:collapsed aria-label={t('ChatSidebar.ariaLabel')}>
	<div class="top">
		{#if !collapsed}
			<a class="vault-name" href={'/vault/' + vaultId} title={t('VaultChatPage.backToChatList')}>
				<ArrowLeftIcon size={20} strokeWidth={1.75} aria-hidden="true" />
				<span>{vaultName}</span>
			</a>
		{/if}
		<button
			type="button"
			class="vc-icon-btn"
			onclick={ontoggle}
			title={collapsed ? t('VaultChatPage.expandPanel') : t('VaultChatPage.collapsePanel')}
			aria-label={collapsed ? t('VaultChatPage.expandPanel') : t('VaultChatPage.collapsePanel')}
			aria-expanded={!collapsed}
		>
			{#if collapsed}
				<PanelLeftOpenIcon size={20} strokeWidth={1.75} aria-hidden="true" />
			{:else}
				<PanelLeftCloseIcon size={20} strokeWidth={1.75} aria-hidden="true" />
			{/if}
		</button>
	</div>

	{#if !collapsed}
		<button type="button" class="vc-btn secondary new-chat" onclick={newChat}>
			<Icon name="draft" size="sm" />
			{t('ChatSidebar.newChat')}
		</button>

		<nav class="list" aria-label={t('ChatSidebar.ariaLabel')}>
			{#if !current}
				<div class="vc-side-head">{groupLabel('today')}</div>
				<span class="vc-side-row" aria-current="page">{t('ChatSidebar.newChat')}</span>
			{/if}
			{#each groups as group (group.key)}
				<div class="vc-side-head">{groupLabel(group.key)}</div>
				{#each group.items as c (c.id)}
					<a
						class="vc-side-row"
						href={'/vault/' + vaultId + '/chat/' + c.id}
						aria-current={c.id === chatId ? 'page' : undefined}
						title={label(c)}
					>
						<span class="name">{label(c)}</span>
					</a>
				{/each}
			{/each}
			{#if loadError && chats.length === 0}
				<p class="note" role="alert">{t('ChatSidebar.loadError')}</p>
			{/if}
		</nav>
	{/if}
</aside>

<style>
	.chat-sidebar {
		flex-shrink: 0;
		min-height: 0;
		height: 100%;
		/* A deliberate width transition: collapsing reflows exactly one
		   sibling (the flex:1 center column), the cheap case. */
		transition: width var(--duration-base) cubic-bezier(0.2, 0, 0, 1);
	}

	.chat-sidebar.collapsed {
		width: 52px;
		padding-inline: var(--space-2);
		align-items: center;
	}

	.top {
		display: flex;
		align-items: center;
		gap: var(--space-1);
		padding-bottom: var(--space-2);
	}

	.collapsed .top {
		padding-bottom: 0;
	}

	.vault-name {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: center;
		gap: var(--space-2);
		height: 32px;
		padding: 0 var(--space-2);
		border-radius: var(--radius-md);
		font: 600 15px/20px var(--font-sans);
		letter-spacing: -0.23px;
		color: var(--label);
		text-decoration: none;
	}

	.vault-name span {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.vault-name:hover {
		background: var(--fill-hover);
	}

	.vault-name:focus-visible,
	.vc-side-row:focus-visible,
	.new-chat:focus-visible,
	.vc-icon-btn:focus-visible {
		outline: 2px solid var(--focus-ring);
		outline-offset: 2px;
	}

	.new-chat {
		justify-content: flex-start;
	}

	.list {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.vc-side-row {
		text-decoration: none;
		flex-shrink: 0;
	}

	.name {
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.note {
		margin: var(--space-3);
		font: 400 13px/18px var(--font-sans);
		color: var(--danger);
	}

	@media (prefers-reduced-motion: reduce) {
		.chat-sidebar {
			transition: none;
		}
	}
</style>
