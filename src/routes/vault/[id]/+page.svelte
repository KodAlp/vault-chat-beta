<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import type { ChatSummary, LibraryNode, ProviderModelOption } from '$lib/types';
	import { collectFilePaths } from '$lib/sourceTree';
	import { setPendingMessage } from '$lib/pending-message';
	import { parseSelectionKey } from '$lib/model-selection';
	import { settings } from '$lib/settings.svelte';
	import { i18n, t } from '$lib/i18n/index.svelte';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import { Badge } from '$lib/components/ui/badge';
	import * as AlertDialog from '$lib/components/ui/alert-dialog';
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
		return new Date(iso).toLocaleString(i18n.locale, {
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
	<title>{data.vaultName} — Vault Agent Toolkit</title>
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
			class="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-[var(--accent)] focus-visible:outline-offset-2"
		>
			<ArrowLeftIcon size={14} aria-hidden="true" /> {t('VaultChatListPage.backToVaults')}
		</a>
		<h1
			class="min-w-0 flex-1 truncate px-2 text-center font-display text-lg font-medium"
			title={data.vaultName}
		>
			{data.vaultName}
		</h1>
		<a
			href="/settings"
			title={t('Common.ayarlar')}
			aria-label={t('Common.ayarlar')}
			class="text-muted-foreground hover:text-primary focus-visible:outline-2 focus-visible:outline-[var(--accent)] focus-visible:outline-offset-2"
		>
			<SettingsIcon size={18} aria-hidden="true" />
		</a>
	</div>

	<!-- Grows to push the composer down off the header (İdeas.txt: "y axis
	     lower than the y middle") when the list below is short or empty,
	     but is capped so a long list still gets most of the vertical space
	     rather than this staying permanently oversized — see the flex-1
	     list region below it: both compete equally for the space left over
	     after the header/composer/footer padding, but only this one has a
	     ceiling, so anything beyond it is handed to the list instead. -->
	<div class="max-h-[min(36vh,20rem)] flex-1" aria-hidden="true"></div>

	<Card.Root class="mb-4 shrink-0">
		<Card.Content class="flex flex-col gap-2">
			<ModelPickerRow
				idPrefix="new-chat"
				{modelOptions}
				{activeProvider}
				{activeModel}
				bind:thinkMode
				bind:reviewMode
				{onModelChange}
			/>
			<div class="flex gap-2">
				<textarea
					id="new-chat-input"
					name="new-chat-input"
					bind:value={question}
					onkeydown={handleKeydown}
					placeholder={t('VaultChatListPage.inputPlaceholder')}
					class="min-h-[3rem] max-h-40 flex-1 resize-none rounded-full border bg-background px-4 py-2.5 text-sm outline-none placeholder:text-muted-foreground"
				></textarea>
				<Button onclick={start} disabled={!question.trim()} class="rounded-full">{t('VaultChatListPage.start')}</Button>
			</div>
		</Card.Content>
	</Card.Root>

	<!-- The one scrolling region on this page — everything below the
	     composer (the chat list, or whichever empty/error state applies)
	     scrolls in place instead of taking the whole page down with it. -->
	<div class="min-h-0 flex-1 overflow-y-auto">
	{#if chats.length > 0}
		<div class="flex flex-col gap-2 pb-2">
			{#each chats as chat (chat.id)}
				{@const n = scopeCount(chat.included_paths_json)}
				<div class="relative">
					{#if renamingId === chat.id}
						<Card.Root>
							<Card.Content class="flex items-center justify-between gap-3 pr-16">
								<input
									type="text"
									bind:value={renameValue}
									onkeydown={(e) => e.key === 'Enter' && submitRename(chat.id)}
									onblur={() => submitRename(chat.id)}
									class="min-w-0 flex-1 rounded border bg-background px-2 py-1 text-sm text-foreground outline-none focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
									use:autofocusInput
								/>
								<span class="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
									{#if n !== null}
										<Badge variant="outline">{t('VaultChatListPage.sourceCountBadge', { count: n })}</Badge>
									{/if}
									{chat.model} · {formatDate(chat.updated_at)}
								</span>
							</Card.Content>
						</Card.Root>
					{:else}
						<a href="/vault/{data.vaultId}/chat/{chat.id}" class="block no-underline">
							<Card.Root class="transition-colors hover:border-primary">
								<Card.Content class="flex items-center justify-between gap-3 pr-16">
									<span class="truncate text-sm text-foreground">{chat.title ?? t('VaultChatListPage.untitled')}</span>
									<span class="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
										{#if n !== null}
											<Badge variant="outline">{t('VaultChatListPage.sourceCountBadge', { count: n })}</Badge>
										{/if}
										{chat.model} · {formatDate(chat.updated_at)}
									</span>
								</Card.Content>
							</Card.Root>
						</a>
					{/if}
					<div class="absolute top-1/2 right-2 flex -translate-y-1/2 gap-1">
						<button
							type="button"
							onclick={() => startRename(chat)}
							title={t('VaultChatListPage.rename')}
							aria-label={t('VaultChatListPage.rename')}
							class="text-muted-foreground hover:text-primary focus-visible:outline-2 focus-visible:outline-[var(--accent)] focus-visible:outline-offset-2"
						>
							<PencilIcon size={14} aria-hidden="true" />
						</button>
						<button
							type="button"
							onclick={() => askDeleteChat(chat.id)}
							title={t('Common.sil')}
							aria-label={t('Common.sil')}
							class="text-muted-foreground hover:text-destructive focus-visible:outline-2 focus-visible:outline-[var(--accent)] focus-visible:outline-offset-2"
						>
							<Trash2Icon size={14} aria-hidden="true" />
						</button>
					</div>
				</div>
			{/each}
		</div>
	{:else if sourceCount === 0}
		<div class="flex flex-col items-center gap-2 rounded-lg border border-dashed py-12 text-center">
			<p class="font-display text-lg text-foreground">{t('VaultChatListPage.noSourcesTitle')}</p>
			<p class="max-w-sm text-sm text-muted-foreground">
				{t('VaultChatListPage.noSourcesDescription')}
			</p>
			<a
				href="/settings/library"
				class="mt-2 inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline focus-visible:outline-2 focus-visible:outline-[var(--accent)] focus-visible:outline-offset-2"
			>
				{t('VaultChatListPage.importSources')} <ArrowRightIcon size={14} aria-hidden="true" />
			</a>
		</div>
	{:else if loadError}
		<p class="text-center text-sm text-destructive">{loadError}</p>
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
