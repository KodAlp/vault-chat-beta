<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import type { ChatSummary, LibraryNode } from '$lib/types';
	import { collectFilePaths } from '$lib/sourceTree';
	import { setPendingMessage } from '$lib/pending-message';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import { Badge } from '$lib/components/ui/badge';
	import * as AlertDialog from '$lib/components/ui/alert-dialog';
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

	onMount(refresh);

	async function refresh() {
		try {
			const res = await fetch(`/api/chats?vault=${encodeURIComponent(data.vaultId)}`);
			if (!res.ok) throw new Error();
			chats = (await res.json()) as ChatSummary[];
			if (chats.length === 0) await checkSources();
		} catch {
			loadError = 'Geçmiş alınamadı';
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

<div class="mx-auto max-w-2xl px-4 pt-8 pb-12">
	<div class="mb-6 flex items-center justify-between">
		<a
			href="/?picker=1"
			class="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-[var(--accent)] focus-visible:outline-offset-2"
		>
			<ArrowLeftIcon size={14} aria-hidden="true" /> Vault'lar
		</a>
		<h1 class="font-display text-lg font-medium">{data.vaultName}</h1>
		<a
			href="/settings"
			title="Ayarlar"
			aria-label="Ayarlar"
			class="text-muted-foreground hover:text-primary focus-visible:outline-2 focus-visible:outline-[var(--accent)] focus-visible:outline-offset-2"
		>
			<SettingsIcon size={18} aria-hidden="true" />
		</a>
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
										<Badge variant="outline">{n} kaynak</Badge>
									{/if}
									{chat.model} · {formatDate(chat.updated_at)}
								</span>
							</Card.Content>
						</Card.Root>
					{:else}
						<a href="/vault/{data.vaultId}/chat/{chat.id}" class="block no-underline">
							<Card.Root class="transition-colors hover:border-primary">
								<Card.Content class="flex items-center justify-between gap-3 pr-16">
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
					{/if}
					<div class="absolute top-1/2 right-2 flex -translate-y-1/2 gap-1">
						<button
							type="button"
							onclick={() => startRename(chat)}
							title="Yeniden adlandır"
							aria-label="Yeniden adlandır"
							class="text-muted-foreground hover:text-primary focus-visible:outline-2 focus-visible:outline-[var(--accent)] focus-visible:outline-offset-2"
						>
							<PencilIcon size={14} aria-hidden="true" />
						</button>
						<button
							type="button"
							onclick={() => askDeleteChat(chat.id)}
							title="Sil"
							aria-label="Sil"
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
			<p class="font-display text-lg text-foreground">Henüz kaynak yok</p>
			<p class="max-w-sm text-sm text-muted-foreground">
				Sorularının kaynağa dayalı, gösterilebilir cevaplar alması için önce Obsidian kasandan
				not içe aktarman gerekiyor — aksi halde her soru "kapsamda yok" döner.
			</p>
			<a
				href="/settings/library"
				class="mt-2 inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline focus-visible:outline-2 focus-visible:outline-[var(--accent)] focus-visible:outline-offset-2"
			>
				Kaynakları içe aktar <ArrowRightIcon size={14} aria-hidden="true" />
			</a>
		</div>
	{:else if loadError}
		<p class="text-center text-sm text-destructive">{loadError}</p>
	{/if}
</div>

<AlertDialog.Root bind:open={confirmingDelete}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>Sohbet silinsin mi?</AlertDialog.Title>
			<AlertDialog.Description>
				Bu sohbet ve içindeki tüm mesajlar kalıcı olarak silinecek. Bu işlem geri alınamaz.
			</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>Vazgeç</AlertDialog.Cancel>
			<AlertDialog.Action
				variant="destructive"
				disabled={deleting}
				onclick={(e) => {
					e.preventDefault();
					confirmDeleteChat();
				}}
			>
				{deleting ? 'Siliniyor...' : 'Sil'}
			</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
