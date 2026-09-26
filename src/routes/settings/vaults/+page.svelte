<script lang="ts">
	import { onMount } from 'svelte';
	import type { VaultRecord, VaultWithStatus } from '$lib/types';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Badge } from '$lib/components/ui/badge';
	import { Switch } from '$lib/components/ui/switch';
	import * as Card from '$lib/components/ui/card';
	import * as AlertDialog from '$lib/components/ui/alert-dialog';
	import { t } from '$lib/i18n/index.svelte';
	import { readResponseError } from '$lib/server-error';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';

	// Stable per-instance id prefix for label/control association.
	const uid = $props.id();

	let vaults = $state<VaultWithStatus[]>([]);
	let activeVaultId = $state<string | null>(null);
	let loadError = $state('');
	let newVaultName = $state('');
	let createError = $state('');
	let creatingVault = $state(false);
	let renamingId = $state<string | null>(null);
	let renameValue = $state('');
	let renameBusy = $state(false);
	let activateBusyId = $state<string | null>(null);
	let deleteTarget = $state<{ vault: VaultRecord; chatCount: number } | null>(null);
	let deleteError = $state('');
	// İ6 (Aşama 8): the one-time "keep existing vaults open to MCP, or close
	// them?" prompt — see vaults.ts's RegistryFile doc comment. Hidden once
	// answered, whichever way; never shown again after that.
	let showMcpMigration = $state(false);
	let mcpMigrationBusy = $state(false);
	let mcpToggleBusy = $state<string | null>(null);

	async function loadVaults() {
		try {
			const res = await fetch('/api/vaults');
			if (!res.ok) throw new Error();
			const data = (await res.json()) as {
				vaults: VaultWithStatus[];
				activeVaultId: string | null;
				needsMcpMigrationPrompt: boolean;
			};
			vaults = data.vaults;
			activeVaultId = data.activeVaultId;
			showMcpMigration = data.needsMcpMigrationPrompt;
		} catch {
			loadError = t('VaultsSettingsPage.loadError');
		}
	}

	onMount(loadVaults);

	async function resolveMcpMigration(exposeAll: boolean) {
		mcpMigrationBusy = true;
		try {
			await fetch('/api/vaults/mcp-migration', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ exposeAll })
			});
			showMcpMigration = false;
			await loadVaults();
		} catch {
			loadError = t('VaultsSettingsPage.mcpMigrationFailed');
		} finally {
			mcpMigrationBusy = false;
		}
	}

	async function toggleMcpExposed(vault: VaultWithStatus) {
		mcpToggleBusy = vault.id;
		try {
			await fetch(`/api/vaults/${vault.id}`, {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ mcpExposed: !vault.mcpExposed })
			});
			await loadVaults();
		} catch {
			loadError = t('VaultsSettingsPage.mcpToggleFailed');
		} finally {
			mcpToggleBusy = null;
		}
	}

	async function createVault() {
		createError = '';
		const name = newVaultName.trim();
		if (!name || creatingVault) return;
		creatingVault = true;
		try {
			const res = await fetch('/api/vaults', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ name })
			});
			if (!res.ok) {
				createError = await readResponseError(res);
				return;
			}
			newVaultName = '';
			await loadVaults();
		} catch {
			createError = t('VaultsSettingsPage.createFailed');
		} finally {
			creatingVault = false;
		}
	}

	async function activate(id: string) {
		if (activateBusyId) return;
		activateBusyId = id;
		try {
			await fetch(`/api/vaults/${id}/activate`, { method: 'POST' });
			await loadVaults();
		} catch {
			loadError = t('VaultsSettingsPage.activateFailed');
		} finally {
			activateBusyId = null;
		}
	}

	function startRename(vault: VaultRecord) {
		renamingId = vault.id;
		renameValue = vault.name;
	}

	async function submitRename(id: string) {
		const name = renameValue.trim();
		if (!name || renameBusy) return;
		renameBusy = true;
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
		} finally {
			renameBusy = false;
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
			if (!res.ok) {
				deleteError = await readResponseError(res);
				return;
			}
			deleteTarget = null;
			await loadVaults();
		} catch {
			deleteError = t('VaultsSettingsPage.deleteFailed');
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

	{#if showMcpMigration}
		<!-- İ6 one-time migration: pre-existing vaults default to CLOSED under
		     the new MCP-exposure gate, which would silently stop working for
		     anyone whose MCP setup (Claude Desktop/Code) already reached every
		     vault implicitly — this lets them keep that working exactly as it
		     was, or adopt the new closed-by-default posture, once, explicitly. -->
		<Card.Root class="mb-6 border-primary">
			<Card.Header>
				<Card.Title level={2}>{t('VaultsSettingsPage.mcpMigrationTitle')}</Card.Title>
			</Card.Header>
			<Card.Content class="flex flex-col gap-3">
				<p class="text-sm text-muted-foreground">{t('VaultsSettingsPage.mcpMigrationDescription')}</p>
				<div class="flex gap-2">
					<Button size="sm" disabled={mcpMigrationBusy} onclick={() => resolveMcpMigration(true)}>
						{t('VaultsSettingsPage.mcpMigrationKeepOpen')}
					</Button>
					<Button size="sm" variant="outline" disabled={mcpMigrationBusy} onclick={() => resolveMcpMigration(false)}>
						{t('VaultsSettingsPage.mcpMigrationCloseAll')}
					</Button>
				</div>
			</Card.Content>
		</Card.Root>
	{/if}

	<Card.Root class="mb-6">
		<Card.Header>
			<Card.Title level={2}>{t('VaultsSettingsPage.existingVaultsTitle')}</Card.Title>
		</Card.Header>
		<Card.Content class="flex flex-col gap-2">
			{#each vaults as vault (vault.id)}
				<div
					class="flex flex-col gap-2 rounded-lg border px-3 py-2 text-sm"
					class:border-primary={vault.id === activeVaultId}
				>
					<div class="flex items-center justify-between gap-3">
					{#if renamingId === vault.id}
						<Input
							id="{uid}-rename-{vault.id}"
							type="text"
							aria-label={t('VaultsSettingsPage.rename')}
							bind:value={renameValue}
							class="h-8 max-w-[16rem]"
							disabled={renameBusy}
							onkeydown={(e) => e.key === 'Enter' && submitRename(vault.id)}
						/>
						<div class="flex shrink-0 gap-1.5">
							<Button size="sm" disabled={renameBusy} onclick={() => submitRename(vault.id)}>{t('Common.kaydet')}</Button>
							<Button size="sm" variant="ghost" disabled={renameBusy} onclick={() => (renamingId = null)}>{t('Common.vazgec')}</Button>
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
								<Button size="sm" variant="outline" disabled={activateBusyId === vault.id} onclick={() => activate(vault.id)}>
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
					<div class="flex items-center justify-between gap-3 border-t pt-2">
						<span class="text-xs text-muted-foreground">{t('VaultsSettingsPage.mcpExposedLabel')}</span>
						<Switch
							checked={vault.mcpExposed === true}
							disabled={mcpToggleBusy === vault.id}
							onCheckedChange={() => toggleMcpExposed(vault)}
						/>
					</div>
				</div>
			{/each}
		</Card.Content>
	</Card.Root>

	<Card.Root>
		<Card.Header>
			<Card.Title level={2}>{t('VaultsSettingsPage.newVaultTitle')}</Card.Title>
		</Card.Header>
		<Card.Content>
			<div class="flex gap-2">
				<Input
					type="text"
					placeholder={t('VaultsSettingsPage.vaultNamePlaceholder')}
					bind:value={newVaultName}
					class="max-w-xs"
					disabled={creatingVault}
					onkeydown={(e) => e.key === 'Enter' && createVault()}
				/>
				<Button onclick={createVault} disabled={!newVaultName.trim() || creatingVault}>{t('VaultsSettingsPage.create')}</Button>
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
