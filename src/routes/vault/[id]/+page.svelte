<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import type { ChatSummary, LibraryNode, ProviderModelOption } from '$lib/types';
	import { collectFilePaths } from '$lib/sourceTree';
	import { setPendingMessage } from '$lib/pending-message';
	import { parseSelectionKey } from '$lib/model-selection';
	import { settings } from '$lib/settings.svelte';
	import { i18n, t } from '$lib/i18n/index.svelte';
	import { intlLocale } from '$lib/i18n/locales';
	import { Badge } from '$lib/components/ui/badge';
	import * as AlertDialog from '$lib/components/ui/alert-dialog';
	import Icon from '$lib/components/Icon.svelte';
	import ModelPickerRow from '$lib/components/ModelPickerRow.svelte';
	import SettingsIcon from '@lucide/svelte/icons/settings';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import ArrowRightIcon from '@lucide/svelte/icons/arrow-right';
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let chats = $state<ChatSummary[]>([]);
	let loadError = $state('');
	let question = $state('');

	// Model/provider/think-mode picker for the chat about to be created —
	// see pending-message.ts. Undefined override falls back to the current
	// task default, exactly like Chat.svelte's own header selector; this
	// choice applies only to the new chat, never to the global settings
	// defaults (per product decision — see study-artifacts/model-provider
	// skill discussion this fixes: previously there was no way to pick
	// anything before the first message, so every new chat silently used
	// whatever the default provider happened to be).
	let modelOptions = $state<ProviderModelOption[]>([]);
	let overrideModel = $state<string | undefined>(undefined);
	let overrideProvider = $state<string | undefined>(undefined);
	let thinkMode = $state(false);
	/** F6 — carried into the new chat's initial mode via pending-message.ts's `mode`, same hand-off as
	 * think/model/provider above. */
	let reviewMode = $state(false);
	let activeModel = $derived(overrideModel ?? (thinkMode ? settings.reasoningModel : settings.fastModel));
	let activeProvider = $derived(
		overrideProvider ?? (thinkMode ? settings.reasoningProvider : settings.fastProvider)
	);

	function onModelChange(key: string) {
		const { providerId, modelId } = parseSelectionKey(key);
		overrideModel = modelId;
		overrideProvider = providerId;
	}

	// Rename: renamingId marks which card (if any) is showing the input in
	// place of its <a>-wrapped title — see the markup below for why that
	// swap, not an input nested inside the anchor, is the safe approach.
	let renamingId = $state<string | null>(null);
	let renameValue = $state('');

	// Delete: confirmingDelete gates the single shared AlertDialog;
	// deleteTargetId tracks which chat it's asking about.
	let confirmingDelete = $state(false);
	let deleteTargetId = $state<string | null>(null);
	let deleting = $state(false);
	// null = not checked yet. Only fetched when the chat list turns out
	// empty (see refresh()) — a returning user with an established library
	// never pays for this extra request; it exists purely to tell "no
	// chats yet, but nothing's been imported either" (the real first-run
	// gap: every answer would come back empty with no explanation why)
	// apart from "no chats yet, library's fine." Reuses the same
	// /api/library/tree read SourceTree.svelte already uses — no new
	// server code.
	let sourceCount = $state<number | null>(null);

	onMount(() => {
		refresh();
		refreshModelOptions();
	});

	async function refreshModelOptions() {
		try {
			const res = await fetch('/api/providers/models');
			if (res.ok) modelOptions = (await res.json()) as ProviderModelOption[];
		} catch {
			// Picker just shows the current default as a lone option — not fatal.
		}
	}

	async function refresh() {
		try {
			const res = await fetch(`/api/chats?vault=${encodeURIComponent(data.vaultId)}`);
			if (!res.ok) throw new Error();
			chats = (await res.json()) as ChatSummary[];
			if (chats.length === 0) await checkSources();
		} catch {
			loadError = t('VaultChatListPage.loadError');
		}
	}

	async function checkSources() {
		try {
			const res = await fetch(`/api/library/tree?vault=${encodeURIComponent(data.vaultId)}`);
			if (!res.ok) return;
			const { tree } = (await res.json()) as { tree: LibraryNode[] };
			sourceCount = collectFilePaths(tree).length;
		} catch {
			// The import-nudge empty state just won't show — not worth its
			// own error path on top of the chat-list one above.
		}
	}

	function start() {
		const trimmed = question.trim();
		if (!trimmed) return;
		const chatId = crypto.randomUUID();
		setPendingMessage({
			chatId,
			question: trimmed,
			providerId: overrideProvider,
			modelId: overrideModel,
			think: thinkMode,
			mode: reviewMode ? 'review' : undefined
		});
		goto(`/vault/${data.vaultId}/chat/${chatId}`);
	}

	function handleKeydown(e: KeyboardEvent) {
		// An IME composing a candidate must not also submit the message — see
		// Chat.svelte's identical guard. keyCode 229 covers older engines that
		// don't set isComposing.
		if (e.isComposing || e.keyCode === 229) return;
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			start();
		}
	}

	// i18n.locale, not a hardcoded 'tr' (as this was before) — see
	// VaultCard.svelte's identical fix: Locale's two values are themselves
	// valid BCP-47 tags, so switching the UI language now actually changes
	// this instead of leaving every timestamp Turkish regardless of setting.
	function formatDate(iso: string): string {
		return new Date(iso).toLocaleString(intlLocale(i18n.locale), {
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

	function startRename(chat: ChatSummary) {
		renameValue = chat.title ?? '';
		renamingId = chat.id;
	}

	async function submitRename(id: string) {
		// Enter fires this, then removing the <input> from the DOM fires a
		// synthetic blur that would otherwise re-submit with stale state —
		// same guard LibraryTreeNode.svelte's rename uses for the same reason.
		if (renamingId !== id) return;
		renamingId = null;
		const title = renameValue.trim();
		if (!title) return;
		try {
			const res = await fetch(`/api/chats/${id}`, {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ title })
			});
			if (res.ok) chats = chats.map((c) => (c.id === id ? { ...c, title } : c));
		} catch {
			// Title just won't update locally; not worth its own error path.
		}
	}

	// Svelte-idiomatic stand-in for the native autofocus attribute (which
	// a11y linting flags as disorienting when used carelessly) — here it's
	// justified (the input replaces the title text at the exact spot the
	// user just clicked "rename" on), but this achieves the same one-time
	// focus-on-mount without tripping that warning.
	function autofocusInput(node: HTMLInputElement) {
		node.focus();
	}

	function askDeleteChat(id: string) {
		deleteTargetId = id;
		confirmingDelete = true;
	}

	async function confirmDeleteChat() {
		confirmingDelete = false;
		if (!deleteTargetId) return;
		const id = deleteTargetId;
		deleting = true;
		try {
			const res = await fetch(`/api/chats/${id}`, { method: 'DELETE' });
			if (res.ok) chats = chats.filter((c) => c.id !== id);
		} finally {
			deleting = false;
			deleteTargetId = null;
		}
	}
</script>

<svelte:head>
	<title>{data.vaultName} — Vault Chat</title>
</svelte:head>

<!-- height:h-full + flex column, same mechanism as Chat.svelte's own root
     (.chat { height:100% }) — this route's box always sizes to exactly
     +layout.svelte's .app-content, so that container's own overflow-y:auto
     never triggers and this page owns its own internal scrolling instead
     (İdeas.txt: the composer used to sit pinned at the very top and the
     WHOLE PAGE scrolled, burying it once there were enough chats to fill
     the screen). -->
<div class="mx-auto flex h-full max-w-2xl flex-col px-4 pb-4">
	<div class="mt-6 mb-2 flex shrink-0 items-center justify-between">
		<a
			href="/?picker=1"
			class="flex items-center gap-1 rounded-[var(--radius-md)] px-1 text-[13px] leading-[18px] text-[var(--label-secondary)] hover:text-[var(--label)] focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)] focus-visible:outline-offset-2"
		>
			<ArrowLeftIcon class="rtl-flip" size={16} strokeWidth={1.75} aria-hidden="true" /> {t('VaultChatListPage.backToVaults')}
		</a>
		<span
			class="min-w-0 flex-1 truncate px-2 text-center text-[15px] leading-5 font-semibold tracking-[-0.23px]"
			title={data.vaultName}
		>
			{data.vaultName}
		</span>
		<a
			href="/settings"
			title={t('Common.ayarlar')}
			aria-label={t('Common.ayarlar')}
			class="vc-icon-btn focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)] focus-visible:outline-offset-2"
		>
			<SettingsIcon size={20} strokeWidth={1.75} aria-hidden="true" />
		</a>
	</div>

	<!-- Grows to push the hero/composer down off the header when the list
	     below is short or empty, but is capped so a long list still gets
	     most of the vertical space — see the flex-1 list region below. -->
	<div class="max-h-[min(14vh,8rem)] flex-1" aria-hidden="true"></div>

	<div class="vc-empty shrink-0" style="padding-block: var(--space-6);">
		<h1 style="max-width: 16ch;">{t('VaultChatListPage.heroTitle')}</h1>
		<p>{t('VaultChatListPage.heroSubtitle')}</p>
	</div>

	<div class="vc-composer mx-auto mb-6 shrink-0">
		<textarea
			id="new-chat-input"
			name="new-chat-input"
			rows="1"
			bind:value={question}
			onkeydown={handleKeydown}
			placeholder={t('VaultChatListPage.inputPlaceholder')}
		></textarea>
		<div class="vc-composer-bar" style="flex-wrap: wrap;">
			<ModelPickerRow
				idPrefix="new-chat"
				{modelOptions}
				{activeProvider}
				{activeModel}
				bind:thinkMode
				bind:reviewMode
				{onModelChange}
				class="new-chat-tools"
			/>
			<span class="spacer"></span>
			<button
				type="button"
				class="vc-send"
				onclick={start}
				disabled={!question.trim()}
				aria-label={t('VaultChatListPage.start')}
				title={t('VaultChatListPage.start')}
			>
				<Icon name="send" />
			</button>
		</div>
	</div>

	<!-- The one scrolling region on this page — everything below the
	     composer (the chat list, or whichever empty/error state applies)
	     scrolls in place instead of taking the whole page down with it. -->
	<div class="min-h-0 flex-1 overflow-y-auto">
	{#if chats.length > 0}
		<h2 class="vc-group-title" style="padding-inline: 0;">{t('VaultChatListPage.recentChats')}</h2>
		<ul class="vc-list m-0 list-none p-0 pb-0">
			{#each chats as chat (chat.id)}
				{@const n = scopeCount(chat.included_paths_json)}
				<li class="vc-list-row relative p-0" style="padding: 0;">
					{#if renamingId === chat.id}
						<div class="flex min-h-[52px] min-w-0 flex-1 items-center justify-between gap-3 py-2 pe-20 ps-4">
							<input
								type="text"
								bind:value={renameValue}
								onkeydown={(e) => e.key === 'Enter' && submitRename(chat.id)}
								onblur={() => submitRename(chat.id)}
								aria-label={t('VaultChatListPage.rename')}
								class="min-w-0 flex-1 rounded-[var(--radius-md)] bg-[var(--fill-control)] px-3 py-1 text-[15px] text-[var(--label)] shadow-[inset_0_0_0_1px_var(--separator-strong)] outline-none focus-visible:shadow-[inset_0_0_0_1px_var(--border-control),0_0_0_2px_var(--focus-ring)]"
								use:autofocusInput
							/>
							<span class="flex shrink-0 items-center gap-2 text-[13px] leading-[18px] text-[var(--label-secondary)]">
								{#if n !== null}
									<Badge variant="secondary">{t('VaultChatListPage.sourceCountBadge', { count: n })}</Badge>
								{/if}
								{chat.model} · {formatDate(chat.updated_at)}
							</span>
						</div>
					{:else}
						<a
							href="/vault/{data.vaultId}/chat/{chat.id}"
							class="flex min-h-[52px] min-w-0 flex-1 items-center justify-between gap-3 py-2 pe-20 ps-4 no-underline hover:bg-[var(--fill-hover)] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--focus-ring)]"
						>
							<span class="truncate text-[15px] leading-5 font-medium tracking-[-0.23px] text-[var(--label)]">{chat.title ?? t('VaultChatListPage.untitled')}</span>
							<span class="flex shrink-0 items-center gap-2 text-[13px] leading-[18px] text-[var(--label-secondary)]">
								{#if n !== null}
									<Badge variant="secondary">{t('VaultChatListPage.sourceCountBadge', { count: n })}</Badge>
								{/if}
								{chat.model} · {formatDate(chat.updated_at)}
							</span>
						</a>
					{/if}
					<div class="absolute top-1/2 end-2 flex -translate-y-1/2 gap-0.5">
						<button
							type="button"
							onclick={() => startRename(chat)}
							title={t('VaultChatListPage.rename')}
							aria-label={t('VaultChatListPage.rename')}
							class="vc-icon-btn"
							style="width: 28px; height: 28px;"
						>
							<PencilIcon size={16} strokeWidth={1.75} aria-hidden="true" />
						</button>
						<button
							type="button"
							onclick={() => askDeleteChat(chat.id)}
							title={t('Common.sil')}
							aria-label={t('Common.sil')}
							class="vc-icon-btn hover:!text-[var(--danger)]"
							style="width: 28px; height: 28px;"
						>
							<Trash2Icon size={16} strokeWidth={1.75} aria-hidden="true" />
						</button>
					</div>
				</li>
			{/each}
		</ul>
	{:else if sourceCount === 0}
		<div class="vc-empty" style="padding-block: var(--space-6);">
			<p class="text-[17px] leading-[22px] font-semibold text-[var(--label)]">{t('VaultChatListPage.noSourcesTitle')}</p>
			<p>{t('VaultChatListPage.noSourcesDescription')}</p>
			<a href="/settings/import" class="vc-btn secondary no-underline">
				{t('VaultChatListPage.importSources')} <ArrowRightIcon class="rtl-flip" size={16} strokeWidth={1.75} aria-hidden="true" />
			</a>
		</div>
	{:else if loadError}
		<p class="text-center text-[15px] text-[var(--danger)]">{loadError}</p>
	{/if}
	</div>
</div>

<AlertDialog.Root bind:open={confirmingDelete}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>{t('VaultChatListPage.deleteChatTitle')}</AlertDialog.Title>
			<AlertDialog.Description>
				{t('VaultChatListPage.deleteChatDescription')}
			</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>{t('Common.vazgec')}</AlertDialog.Cancel>
			<AlertDialog.Action
				variant="destructive"
				disabled={deleting}
				onclick={(e) => {
					e.preventDefault();
					confirmDeleteChat();
				}}
			>
				{deleting ? t('VaultChatListPage.deleting') : t('Common.sil')}
			</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>

<style>
	.vc-composer textarea {
		field-sizing: content;
		max-height: 10rem;
		overflow-y: auto;
	}
	.vc-composer textarea:focus-visible {
		outline: none;
	}
	.vc-composer-bar :global(.new-chat-tools) {
		padding: 0;
		min-width: 0;
	}
</style>
