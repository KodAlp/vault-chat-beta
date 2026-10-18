<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import { onMount } from 'svelte';
	import { isTauri, invoke } from '@tauri-apps/api/core';
	import type { VaultRecord, VaultWithStatus } from '$lib/types';
	import { AUTO_CONFIRM_MODES, type AutoConfirmMode } from '$lib/mcp-auto-confirm-policy';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { Badge } from '$lib/components/ui/badge';
	import { Switch } from '$lib/components/ui/switch';
	import * as Card from '$lib/components/ui/card';
	import * as AlertDialog from '$lib/components/ui/alert-dialog';
	import ReindexDialog from '$lib/components/ReindexDialog.svelte';
	import BackupCard from '$lib/components/BackupCard.svelte';
	import McpClientConnect from '$lib/components/McpClientConnect.svelte';
	import { t } from '$lib/i18n/index.svelte';
	import { readResponseError } from '$lib/server-error';

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
	// Aşama 3c — the in-app reindex action, replacing "run npm run index"
	// instructions in this desktop/app context. One dialog for the page;
	// reindexTargetId picks which vault it's currently aimed at.
	let reindexTargetId = $state<string | null>(null);
	let reindexOpen = $state(false);
	// İ6 (Aşama 8): the one-time "keep existing vaults open to MCP, or close
	// them?" prompt — see vaults.ts's RegistryFile doc comment. Hidden once
	// answered, whichever way; never shown again after that.
	let showMcpMigration = $state(false);
	let mcpMigrationBusy = $state(false);
	let mcpToggleBusy = $state<string | null>(null);
	// Per-vault "the app confirms MCP imports for me" choice. Written only through PATCH /api/vaults/[id] (session-gated);
	// no MCP tool or /api/mcp/* route can reach it, so an agent can never switch it on for itself.
	let autoConfirmBusy = $state<string | null>(null);
	let autoConfirmError = $state('');
	const autoConfirmLabels: Record<AutoConfirmMode, string> = {
		off: 'VaultsSettingsPage.autoConfirmOff',
		clean: 'VaultsSettingsPage.autoConfirmClean',
		all: 'VaultsSettingsPage.autoConfirmAll'
	};

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

	// MCP import folders: where an AI agent connected over MCP may read local files from (GET/PUT /api/settings/mcp).
	let mcpRoots = $state<string[]>([]);
	let mcpRootInput = $state('');
	let mcpRootsBusy = $state(false);
	let mcpRootsError = $state('');
	// Developer switch for the edit_note MCP tool (off by default; only this page can change it).
	let allowEditNote = $state(false);

	onMount(async () => {
		try {
			const res = await fetch('/api/settings/mcp');
			if (!res.ok) throw new Error();
			const loaded = (await res.json()) as { allowedImportRoots: string[]; allowEditNote?: boolean };
			mcpRoots = loaded.allowedImportRoots;
			allowEditNote = loaded.allowEditNote === true;
		} catch {
			mcpRootsError = t('McpImportSettings.loadFailed');
		}
	});

	/** Saves the whole list; on a coded rejection (bad path) the list stays as it was. */
	async function saveMcpRoots(next: string[]): Promise<boolean> {
		mcpRootsBusy = true;
		mcpRootsError = '';
		try {
			const res = await fetch('/api/settings/mcp', {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ allowedImportRoots: next })
			});
			if (!res.ok) {
				mcpRootsError = await readResponseError(res);
				return false;
			}
			mcpRoots = ((await res.json()) as { allowedImportRoots: string[] }).allowedImportRoots;
			return true;
		} catch {
			mcpRootsError = t('McpImportSettings.saveFailed');
			return false;
		} finally {
			mcpRootsBusy = false;
		}
	}

	async function addMcpRoot(raw: string) {
		const p = raw.trim();
		if (!p || mcpRootsBusy || mcpRoots.includes(p)) return;
		if (await saveMcpRoots([...mcpRoots, p])) mcpRootInput = '';
	}

	async function pickMcpRoot() {
		const { open } = await import('@tauri-apps/plugin-dialog');
		const picked = await open({ directory: true, multiple: false });
		if (typeof picked === 'string') await addMcpRoot(picked);
	}

	async function saveAllowEditNote(next: boolean) {
		mcpRootsBusy = true;
		mcpRootsError = '';
		try {
			const res = await fetch('/api/settings/mcp', {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ allowEditNote: next })
			});
			if (!res.ok) {
				mcpRootsError = await readResponseError(res);
				return;
			}
			allowEditNote = ((await res.json()) as { allowEditNote?: boolean }).allowEditNote === true;
		} catch {
			mcpRootsError = t('McpImportSettings.saveFailed');
		} finally {
			mcpRootsBusy = false;
		}
	}

	function removeMcpRoot(root: string) {
		if (!mcpRootsBusy) void saveMcpRoots(mcpRoots.filter((r) => r !== root));
	}

	// Desktop (Tauri) first-run vault config — what the app launches into NEXT time
	// (not the vault being browsed now). Moved here from the old settings home page.
	const runningInTauri = isTauri();
	let desktopVaultPath = $state('');
	let desktopVaultName = $state('');
	let desktopSaveStatus = $state<'idle' | 'saved' | 'error'>('idle');

	onMount(async () => {
		if (!runningInTauri) return;
		try {
			const cfg = await invoke<{ vault_path: string; vault_name: string } | null>('get_vault_config');
			if (cfg) {
				desktopVaultPath = cfg.vault_path;
				desktopVaultName = cfg.vault_name;
			}
		} catch {
			// Page still usable without this — just starts blank.
		}
	});

	async function pickVaultFolder() {
		const { open } = await import('@tauri-apps/plugin-dialog');
		const picked = await open({ directory: true, multiple: false });
		if (typeof picked === 'string') desktopVaultPath = picked;
	}

	async function saveVaultConfig() {
		desktopSaveStatus = 'idle';
		try {
			await invoke('update_vault_config', { vaultPath: desktopVaultPath, vaultName: desktopVaultName });
			desktopSaveStatus = 'saved';
		} catch {
			desktopSaveStatus = 'error';
		}
	}

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

	async function setAutoConfirm(vault: VaultWithStatus, mode: AutoConfirmMode) {
		if (autoConfirmBusy || (vault.mcpAutoConfirm ?? 'off') === mode) return;
		autoConfirmBusy = vault.id;
		autoConfirmError = '';
		try {
			const res = await fetch(`/api/vaults/${vault.id}`, {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ mcpAutoConfirm: mode })
			});
			if (!res.ok) autoConfirmError = await readResponseError(res);
			await loadVaults();
		} catch {
			autoConfirmError = t('VaultsSettingsPage.autoConfirmFailed');
		} finally {
			autoConfirmBusy = null;
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
	<title>{t('VaultsSettingsPage.title')} — Vault Chat</title>
</svelte:head>

<div>
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
							{#if vault.createdVia === 'mcp'}
								<Badge variant="secondary">{t('McpImportSettings.createdViaMcp')}</Badge>
							{/if}
							{#if vault.unindexedCount > 0}
								<Badge variant="outline" title={t('VaultsSettingsPage.unindexedTitle')}>
									{t('VaultsSettingsPage.unindexedBadge', { count: vault.unindexedCount })}
								</Badge>
							{/if}
							{#if vault.embeddingMismatch}
								<Badge variant="outline" title={t('VaultsSettingsPage.embeddingMismatchTitle')}>
									{t('VaultsSettingsPage.embeddingMismatchBadge')}
								</Badge>
							{/if}
						</span>
						<div class="flex shrink-0 gap-1.5">
							{#if vault.id !== activeVaultId}
								<Button size="sm" variant="outline" disabled={activateBusyId === vault.id} onclick={() => activate(vault.id)}>
									{t('VaultsSettingsPage.activate')}
								</Button>
							{/if}
							{#if vault.unindexedCount > 0 || vault.embeddingMismatch}
								<Button
									size="sm"
									variant="outline"
									onclick={() => {
										reindexTargetId = vault.id;
										reindexOpen = true;
									}}
								>
									<Icon name="refresh" size="sm" />
									{t('VaultsSettingsPage.reindex')}
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
							aria-label={t('VaultsSettingsPage.mcpExposedLabel')}
							onCheckedChange={() => toggleMcpExposed(vault)}
						/>
					</div>
					{#if vault.mcpExposed === true}
						<fieldset class="flex flex-col gap-2 border-t pt-2" disabled={autoConfirmBusy === vault.id}>
							<legend class="text-xs font-medium">{t('VaultsSettingsPage.autoConfirmLabel')}</legend>
							<p class="text-xs text-muted-foreground">{t('VaultsSettingsPage.autoConfirmHelp')}</p>
							{#each AUTO_CONFIRM_MODES as mode (mode)}
								<label class="flex items-start gap-2 text-xs">
									<input
										type="radio"
										class="mt-0.5"
										name="auto-confirm-{vault.id}"
										value={mode}
										checked={(vault.mcpAutoConfirm ?? 'off') === mode}
										onchange={() => setAutoConfirm(vault, mode)}
									/>
									<span>{t(autoConfirmLabels[mode])}</span>
								</label>
							{/each}
							{#if vault.mcpAutoConfirm === 'all'}
								<p class="text-xs text-destructive" role="note">{t('VaultsSettingsPage.autoConfirmAllWarning')}</p>
							{/if}
							{#if autoConfirmError}
								<p class="text-xs text-destructive" role="alert">{autoConfirmError}</p>
							{/if}
						</fieldset>
					{/if}
				</div>
			{/each}
		</Card.Content>
	</Card.Root>

	<Card.Root class="mb-6">
		<Card.Header>
			<Card.Title level={2}>{t('VaultsSettingsPage.newVaultTitle')}</Card.Title>
		</Card.Header>
		<Card.Content>
			<div class="flex gap-2">
				<Input
					type="text"
					placeholder={t('VaultsSettingsPage.vaultNamePlaceholder')}
					aria-label={t('VaultsSettingsPage.vaultNamePlaceholder')}
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

	<Card.Root>
		<Card.Header>
			<Card.Title level={2}>{t('McpImportSettings.title')}</Card.Title>
			<Card.Description>{t('McpImportSettings.description')}</Card.Description>
		</Card.Header>
		<Card.Content class="flex flex-col gap-3">
			{#if mcpRoots.length === 0}
				<p class="text-sm text-muted-foreground">{t('McpImportSettings.empty')}</p>
			{:else}
				<ul class="flex flex-col gap-1.5">
					{#each mcpRoots as root (root)}
						<li class="flex items-center justify-between gap-3 rounded-lg border px-3 py-1.5 text-sm">
							<span class="min-w-0 flex-1 truncate font-mono text-xs" title={root}>{root}</span>
							<Button
								size="sm"
								variant="ghost"
								disabled={mcpRootsBusy}
								aria-label={t('McpImportSettings.removeAria', { path: root })}
								onclick={() => removeMcpRoot(root)}
							>
								{t('PendingImports.remove')}
							</Button>
						</li>
					{/each}
				</ul>
			{/if}
			{#if runningInTauri}
				<div>
					<Button type="button" variant="outline" disabled={mcpRootsBusy} onclick={pickMcpRoot}>{t('McpImportSettings.addFolder')}</Button>
				</div>
			{:else}
				<div class="flex gap-2">
					<Input
						type="text"
						placeholder={t('McpImportSettings.pathPlaceholder')}
						aria-label={t('McpImportSettings.pathPlaceholder')}
						bind:value={mcpRootInput}
						class="max-w-md"
						disabled={mcpRootsBusy}
						onkeydown={(e) => e.key === 'Enter' && addMcpRoot(mcpRootInput)}
					/>
					<Button onclick={() => addMcpRoot(mcpRootInput)} disabled={!mcpRootInput.trim() || mcpRootsBusy}>{t('McpImportSettings.add')}</Button>
				</div>
			{/if}
			<div class="flex items-start justify-between gap-3 border-t pt-3">
				<div class="flex min-w-0 flex-col gap-1">
					<span class="text-sm font-medium">{t('McpImportSettings.editNoteLabel')}</span>
					<p class="text-xs text-muted-foreground">{t('McpImportSettings.editNoteWarning')}</p>
				</div>
				<Switch
					checked={allowEditNote}
					disabled={mcpRootsBusy}
					aria-label={t('McpImportSettings.editNoteLabel')}
					onCheckedChange={(on) => saveAllowEditNote(on)}
				/>
			</div>
			{#if mcpRootsError}
				<p class="text-sm text-destructive" role="alert">{mcpRootsError}</p>
			{/if}
		</Card.Content>
	</Card.Root>

	<div class="mt-6">
		<McpClientConnect />
	</div>

	{#if runningInTauri}
		<Card.Root class="mt-6">
			<Card.Header>
				<Card.Title level={2}>{t('SettingsPage.desktopVaultTitle')}</Card.Title>
				<Card.Description>
					{t('SettingsPage.desktopVaultDescription')}
				</Card.Description>
			</Card.Header>
			<Card.Content class="flex flex-col gap-4">
				<div class="flex flex-col gap-1.5">
					<Label for="{uid}-vault-folder">{t('SettingsPage.vaultFolder')}</Label>
					<div class="flex gap-2">
						<Input id="{uid}-vault-folder" type="text" readonly value={desktopVaultPath} placeholder={t('SettingsPage.vaultFolderPlaceholder')} class="flex-1" />
						<Button type="button" variant="outline" onclick={pickVaultFolder}>{t('SettingsPage.choose')}</Button>
					</div>
				</div>
				<div class="flex flex-col gap-1.5">
					<Label for="{uid}-vault-name">{t('SettingsPage.defaultVaultName')}</Label>
					<Input id="{uid}-vault-name" type="text" bind:value={desktopVaultName} placeholder={t('SettingsPage.defaultVaultNamePlaceholder')} class="max-w-xs" />
				</div>
				<div>
					<Button type="button" onclick={saveVaultConfig}>{t('Common.kaydet')}</Button>
					{#if desktopSaveStatus === 'saved'}
						<span class="ms-2 text-sm text-[var(--success)]">{t('SettingsPage.vaultSaved')}</span>
					{:else if desktopSaveStatus === 'error'}
						<span class="ms-2 text-sm text-destructive" role="alert">{t('SettingsPage.vaultSaveFailed')}</span>
					{/if}
				</div>
			</Card.Content>
		</Card.Root>
	{/if}

	<BackupCard />
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

{#if reindexTargetId}
	<ReindexDialog vaultId={reindexTargetId} bind:open={reindexOpen} onDone={loadVaults} />
{/if}
