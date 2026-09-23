<script lang="ts">
	import { onMount } from 'svelte';
	import type { VaultRecord, VaultWithStatus } from '$lib/types';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Badge } from '$lib/components/ui/badge';
	import * as Card from '$lib/components/ui/card';
	import * as AlertDialog from '$lib/components/ui/alert-dialog';
	import { t } from '$lib/i18n/index.svelte';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';

	let vaults = $state<VaultWithStatus[]>([]);
	let activeVaultId = $state<string | null>(null);
	let loadError = $state('');
	let newVaultName = $state('');
	let createError = $state('');
	let renamingId = $state<string | null>(null);
	let renameValue = $state('');
	let deleteTarget = $state<{ vault: VaultRecord; chatCount: number } | null>(null);
	let deleteError = $state('');

	async function loadVaults() {
		try {
			const res = await fetch('/api/vaults');
			if (!res.ok) throw new Error();
			const data = (await res.json()) as { vaults: VaultWithStatus[]; activeVaultId: string | null };
			vaults = data.vaults;
			activeVaultId = data.activeVaultId;
		} catch {
			loadError = t('VaultsSettingsPage.loadError');
		}
	}

	onMount(loadVaults);

	async function createVault() {
		createError = '';
		const name = newVaultName.trim();
		if (!name) return;
		try {
			const res = await fetch('/api/vaults', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ name })
			});
			if (!res.ok) throw new Error((await res.json().catch(() => null))?.message ?? t('VaultsSettingsPage.createFailed'));
			newVaultName = '';
			await loadVaults();
		} catch (err) {
			createError = err instanceof Error ? err.message : t('VaultsSettingsPage.createFailed');
		}
	}

	async function activate(id: string) {
		try {
			await fetch(`/api/vaults/${id}/activate`, { method: 'POST' });
			await loadVaults();
		} catch {
			loadError = t('VaultsSettingsPage.activateFailed');
		}
	}

	function startRename(vault: VaultRecord) {
		renamingId = vault.id;
		renameValue = vault.name;
	}

	async function submitRename(id: string) {
		const name = renameValue.trim();
		if (!name) return;
		try {
			await fetch(`/api/vaults/${id}`, {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ name })
			});
			renamingId = null;
			await loadVaults();
		} catch {
			loadError = t('VaultsSettingsPage.renameFailed');
		}
	}

	async function requestDelete(vault: VaultRecord) {
		deleteError = '';
		try {
			const res = await fetch(`/api/vaults/${vault.id}`);
			if (!res.ok) throw new Error();
			const info = (await res.json()) as { vault: VaultRecord; chatCount: number };
			deleteTarget = info;
		} catch {
			deleteError = t('VaultsSettingsPage.vaultInfoFailed');
		}
	}

	async function confirmDelete() {
		if (!deleteTarget) return;
		try {
			const res = await fetch(`/api/vaults/${deleteTarget.vault.id}?confirm=true`, {
				method: 'DELETE'
			});
			if (!res.ok) throw new Error((await res.json().catch(() => null))?.message ?? t('VaultsSettingsPage.deleteFailed'));
			deleteTarget = null;
			await loadVaults();
		} catch (err) {
			deleteError = err instanceof Error ? err.message : t('VaultsSettingsPage.deleteFailed');
		}
	}
</script>

<svelte:head>
	<title>{t('VaultsSettingsPage.title')} — Vault Agent Toolkit</title>
</svelte:head>

<div class="mx-auto max-w-2xl px-4 pt-6 pb-12">
	<div class="mb-4 flex items-baseline gap-4">
		<a href="/settings" class="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-[var(--accent)] focus-visible:outline-offset-2">
			<ArrowLeftIcon size={14} aria-hidden="true" /> {t('Common.ayarlar')}
		</a>
		<h1 class="font-display text-xl font-medium">{t('VaultsSettingsPage.title')}</h1>
	</div>

	<p class="mb-6 text-sm text-muted-foreground">
		{t('VaultsSettingsPage.intro')}
	</p>

	{#if loadError}
		<p class="mb-4 text-sm text-destructive">{loadError}</p>
	{/if}

	<Card.Root class="mb-6">
		<Card.Header>
			<Card.Title>{t('VaultsSettingsPage.existingVaultsTitle')}</Card.Title>
		</Card.Header>
		<Card.Content class="flex flex-col gap-2">
			{#each vaults as vault (vault.id)}
				<div
					class="flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-sm"
					class:border-primary={vault.id === activeVaultId}
				>
					{#if renamingId === vault.id}
						<Input
							type="text"
							bind:value={renameValue}
							class="h-8 max-w-[16rem]"
							onkeydown={(e) => e.key === 'Enter' && submitRename(vault.id)}
						/>
						<div class="flex shrink-0 gap-1.5">
							<Button size="sm" onclick={() => submitRename(vault.id)}>{t('Common.kaydet')}</Button>
							<Button size="sm" variant="ghost" onclick={() => (renamingId = null)}>{t('Common.vazgec')}</Button>
						</div>
					{:else}
						<span class="flex items-center gap-2">
							{vault.name}
							{#if vault.id === activeVaultId}
								<Badge variant="secondary">{t('VaultsSettingsPage.active')}</Badge>
							{/if}
							{#if vault.unindexedCount > 0}
								<Badge variant="outline" title={t('VaultsSettingsPage.unindexedTitle', { id: vault.id })}>
									{t('VaultsSettingsPage.unindexedBadge', { count: vault.unindexedCount })}
								</Badge>
							{/if}
						</span>
						<div class="flex shrink-0 gap-1.5">
							{#if vault.id !== activeVaultId}
								<Button size="sm" variant="outline" onclick={() => activate(vault.id)}>
									{t('VaultsSettingsPage.activate')}
								</Button>
							{/if}
							<Button size="sm" variant="ghost" onclick={() => startRename(vault)}>
								{t('VaultsSettingsPage.rename')}
							</Button>
							<Button size="sm" variant="destructive" onclick={() => requestDelete(vault)}>
								{t('Common.sil')}
							</Button>
						</div>
					{/if}
				</div>
			{/each}
		</Card.Content>
	</Card.Root>

	<Card.Root>
		<Card.Header>
			<Card.Title>{t('VaultsSettingsPage.newVaultTitle')}</Card.Title>
		</Card.Header>
		<Card.Content>
			<div class="flex gap-2">
				<Input
					type="text"
					placeholder={t('VaultsSettingsPage.vaultNamePlaceholder')}
					bind:value={newVaultName}
					class="max-w-xs"
					onkeydown={(e) => e.key === 'Enter' && createVault()}
				/>
				<Button onclick={createVault}>{t('VaultsSettingsPage.create')}</Button>
			</div>
			{#if createError}
				<p class="mt-2 text-sm text-destructive">{createError}</p>
			{/if}
		</Card.Content>
	</Card.Root>
</div>

<AlertDialog.Root open={!!deleteTarget} onOpenChange={(open) => !open && (deleteTarget = null)}>
	<AlertDialog.Content>
		{#if deleteTarget}
			<AlertDialog.Header>
				<AlertDialog.Title>{t('VaultsSettingsPage.deleteConfirmTitle', { name: deleteTarget.vault.name })}</AlertDialog.Title>
				<AlertDialog.Description>
					{deleteTarget.chatCount > 0
						? t('VaultsSettingsPage.deleteConfirmWithChats', { chatCount: deleteTarget.chatCount })
						: t('VaultsSettingsPage.deleteConfirmNoChats')}
				</AlertDialog.Description>
			</AlertDialog.Header>
			{#if deleteError}
				<p class="text-sm text-destructive">{deleteError}</p>
			{/if}
			<AlertDialog.Footer>
				<AlertDialog.Cancel>{t('Common.vazgec')}</AlertDialog.Cancel>
				<AlertDialog.Action
					variant="destructive"
					onclick={(e) => {
						e.preventDefault();
						confirmDelete();
					}}
				>
					{t('Common.sil')}
				</AlertDialog.Action>
			</AlertDialog.Footer>
		{/if}
	</AlertDialog.Content>
</AlertDialog.Root>
