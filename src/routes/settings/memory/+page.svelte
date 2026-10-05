<script lang="ts">
	import { onMount } from 'svelte';
	import type { MemoryNoteView } from '$lib/types';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Textarea } from '$lib/components/ui/textarea';
	import { Badge } from '$lib/components/ui/badge';
	import * as Card from '$lib/components/ui/card';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as Select from '$lib/components/ui/select';
	import * as AlertDialog from '$lib/components/ui/alert-dialog';
	import { t } from '$lib/i18n/index.svelte';

	type MemoryType = MemoryNoteView['type'];
	let TYPE_LABELS = $derived<Record<MemoryType, string>>({
		GLOBAL: t('MemorySettingsPage.typeGlobal'),
		PERSONAL: t('MemorySettingsPage.typePersonal')
	});
	const TYPES: MemoryType[] = ['PERSONAL', 'GLOBAL'];

	let notes = $state<MemoryNoteView[]>([]);
	let loaded = $state(false);
	let loadError = $state('');
	let actionError = $state('');
	let busy = $state(false);

	let editorOpen = $state(false);
	let editorId = $state<string | null>(null); // null = adding a new note
	let editorType = $state<MemoryType>('PERSONAL');
	let editorDomain = $state('');
	let editorValue = $state('');
	let editorError = $state('');
	let editorSaving = $state(false);

	async function load() {
		try {
			const res = await fetch('/api/memory');
			if (!res.ok) throw new Error();
			notes = ((await res.json()) as { notes: MemoryNoteView[] }).notes;
			loadError = '';
		} catch {
			loadError = t('MemorySettingsPage.loadError');
		} finally {
			loaded = true;
		}
	}

	function openNew() {
		editorId = null;
		editorType = 'PERSONAL';
		editorDomain = '';
		editorValue = '';
		editorError = '';
		editorOpen = true;
	}

	function openEdit(n: MemoryNoteView) {
		editorId = n.id;
		editorType = n.type;
		editorDomain = n.domain ?? '';
		editorValue = n.value;
		editorError = '';
		editorOpen = true;
	}

	async function saveEditor() {
		const value = editorValue.trim();
		if (!value) {
			editorError = t('MemorySettingsPage.valueRequired');
			return;
		}
		editorSaving = true;
		editorError = '';
		try {
			const res = editorId
				? await fetch(`/api/memory/${editorId}`, {
						method: 'PATCH',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ value })
					})
				: await fetch('/api/memory', {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ type: editorType, domain: editorDomain.trim() || undefined, value })
					});
			if (!res.ok) throw new Error();
			editorOpen = false;
			await load();
		} catch {
			editorError = t('MemorySettingsPage.saveError');
		} finally {
			editorSaving = false;
		}
	}

	let deleteTarget = $state<MemoryNoteView | null>(null);

	function requestRemove(n: MemoryNoteView) {
		deleteTarget = n;
	}

	async function confirmRemove() {
		const n = deleteTarget;
		if (!n) return;
		deleteTarget = null;
		actionError = '';
		busy = true;
		try {
			const res = await fetch(`/api/memory/${n.id}`, { method: 'DELETE' });
			if (!res.ok) throw new Error();
			await load();
		} catch {
			actionError = t('MemorySettingsPage.deleteError');
		} finally {
			busy = false;
		}
	}

	onMount(load);
</script>

<svelte:head>
	<title>{t('MemorySettingsPage.title')} — Vault Chat</title>
</svelte:head>

<div>

	<p class="mb-5 text-sm text-muted-foreground">{t('MemorySettingsPage.intro')}</p>

	{#if loadError}
		<p class="mb-4 text-sm text-destructive">{loadError}</p>
	{/if}
	{#if actionError}
		<p class="mb-4 text-sm text-destructive">{actionError}</p>
	{/if}

	{#if loaded && !loadError}
		<div class="mb-4 flex justify-end">
			<Button onclick={openNew}>{t('MemorySettingsPage.addNote')}</Button>
		</div>
		{#if notes.length === 0}
			<p class="text-sm text-muted-foreground">{t('MemorySettingsPage.empty')}</p>
		{:else}
			<div class="flex flex-col gap-2">
				{#each notes as n (n.id)}
					<Card.Root>
						<Card.Content class="flex flex-wrap items-start justify-between gap-3">
							<div class="min-w-[200px] flex-1">
								<div class="mb-1 flex flex-wrap items-center gap-1.5">
									<Badge variant="outline">{TYPE_LABELS[n.type]}</Badge>
									{#if n.domain}<Badge variant="outline">{n.domain}</Badge>{/if}
								</div>
								<p class="text-sm break-words whitespace-pre-wrap">{n.value}</p>
							</div>
							<div class="flex shrink-0 gap-1.5">
								<Button variant="ghost" size="sm" disabled={busy} onclick={() => openEdit(n)}>{t('MemorySettingsPage.edit')}</Button>
								<Button variant="ghost" size="sm" disabled={busy} onclick={() => requestRemove(n)}>{t('MemorySettingsPage.delete')}</Button>
							</div>
						</Card.Content>
					</Card.Root>
				{/each}
			</div>
		{/if}
	{/if}
</div>

<Dialog.Root bind:open={editorOpen}>
	<Dialog.Content class="sm:max-w-lg">
		<Dialog.Header>
			<Dialog.Title>{editorId ? t('MemorySettingsPage.editDialogTitle') : t('MemorySettingsPage.newDialogTitle')}</Dialog.Title>
		</Dialog.Header>

		{#if !editorId}
			<label class="flex flex-col gap-1 text-sm">
				{t('MemorySettingsPage.typeLabel')}
				<Select.Root type="single" bind:value={editorType}>
					<Select.Trigger class="w-full">{TYPE_LABELS[editorType]}</Select.Trigger>
					<Select.Content>
						{#each TYPES as ty (ty)}
							<Select.Item value={ty} label={TYPE_LABELS[ty]}>{TYPE_LABELS[ty]}</Select.Item>
						{/each}
					</Select.Content>
				</Select.Root>
			</label>
			<label class="flex flex-col gap-1 text-sm">
				{t('MemorySettingsPage.domainLabel')}
				<Input type="text" bind:value={editorDomain} placeholder={t('MemorySettingsPage.domainPlaceholder')} />
			</label>
		{/if}

		<label class="flex flex-col gap-1 text-sm">
			{t('MemorySettingsPage.valueLabel')}
			<Textarea bind:value={editorValue} class="min-h-24" />
		</label>

		{#if editorError}
			<p class="text-sm text-destructive">{editorError}</p>
		{/if}

		<Dialog.Footer>
			<Button variant="outline" onclick={() => (editorOpen = false)}>{t('Common.iptal')}</Button>
			<Button onclick={saveEditor} disabled={editorSaving}>
				{editorSaving ? t('Common.kaydediliyor') : t('Common.kaydet')}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<AlertDialog.Root open={!!deleteTarget} onOpenChange={(open) => !open && (deleteTarget = null)}>
	<AlertDialog.Content>
		{#if deleteTarget}
			<AlertDialog.Header>
				<AlertDialog.Title>{t('MemorySettingsPage.deleteConfirm')}</AlertDialog.Title>
			</AlertDialog.Header>
			<AlertDialog.Footer>
				<AlertDialog.Cancel>{t('Common.vazgec')}</AlertDialog.Cancel>
				<AlertDialog.Action
					variant="destructive"
					onclick={(e) => {
						e.preventDefault();
						confirmRemove();
					}}
				>
					{t('MemorySettingsPage.delete')}
				</AlertDialog.Action>
			</AlertDialog.Footer>
		{/if}
	</AlertDialog.Content>
</AlertDialog.Root>
