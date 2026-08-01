<script lang="ts">
	import { onMount } from 'svelte';
	import type { VaultRecord } from '$lib/types';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Badge } from '$lib/components/ui/badge';
	import * as Card from '$lib/components/ui/card';
	import * as AlertDialog from '$lib/components/ui/alert-dialog';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';

	let vaults = $state<VaultRecord[]>([]);
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
			const data = (await res.json()) as { vaults: VaultRecord[]; activeVaultId: string | null };
			vaults = data.vaults;
			activeVaultId = data.activeVaultId;
		} catch {
			loadError = 'Vault listesi alınamadı.';
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
			if (!res.ok) throw new Error((await res.json().catch(() => null))?.message ?? 'Oluşturulamadı');
			newVaultName = '';
			await loadVaults();
		} catch (err) {
			createError = err instanceof Error ? err.message : 'Vault oluşturulamadı.';
		}
	}

	async function activate(id: string) {
		try {
			await fetch(`/api/vaults/${id}/activate`, { method: 'POST' });
			await loadVaults();
		} catch {
			loadError = 'Aktif vault değiştirilemedi.';
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
			loadError = 'Yeniden adlandırılamadı.';
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
			deleteError = 'Vault bilgisi alınamadı.';
		}
	}

	async function confirmDelete() {
		if (!deleteTarget) return;
		try {
			const res = await fetch(`/api/vaults/${deleteTarget.vault.id}?confirm=true`, {
				method: 'DELETE'
			});
			if (!res.ok) throw new Error((await res.json().catch(() => null))?.message ?? 'Silinemedi');
			deleteTarget = null;
			await loadVaults();
		} catch (err) {
			deleteError = err instanceof Error ? err.message : 'Vault silinemedi.';
		}
	}
</script>

<svelte:head>
	<title>Vault'lar — Vault Agent Toolkit</title>
</svelte:head>

<div class="mx-auto max-w-2xl px-4 pt-6 pb-12">
	<div class="mb-4 flex items-baseline gap-4">
		<a href="/settings" class="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-[var(--accent)] focus-visible:outline-offset-2">
			<ArrowLeftIcon size={14} aria-hidden="true" /> Ayarlar
		</a>
		<h1 class="font-display text-xl font-medium">Vault'lar</h1>
	</div>

	<p class="mb-6 text-sm text-muted-foreground">
		Her vault kendi kaynak kütüphanesini ve arama indeksini tutar — birbirlerine karışmazlar.
		Sohbet geçmişi vault başına ayrılır, sohbet ekranı her zaman aktif vault üzerinde çalışır.
	</p>

	{#if loadError}
		<p class="mb-4 text-sm text-destructive">{loadError}</p>
	{/if}

	<Card.Root class="mb-6">
		<Card.Header>
			<Card.Title>Mevcut vault'lar</Card.Title>
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
							<Button size="sm" onclick={() => submitRename(vault.id)}>Kaydet</Button>
							<Button size="sm" variant="ghost" onclick={() => (renamingId = null)}>Vazgeç</Button>
						</div>
					{:else}
						<span class="flex items-center gap-2">
							{vault.name}
							{#if vault.id === activeVaultId}
								<Badge variant="secondary">aktif</Badge>
							{/if}
						</span>
						<div class="flex shrink-0 gap-1.5">
							{#if vault.id !== activeVaultId}
								<Button size="sm" variant="outline" onclick={() => activate(vault.id)}>
									Aktif yap
								</Button>
							{/if}
							<Button size="sm" variant="ghost" onclick={() => startRename(vault)}>
								Yeniden adlandır
							</Button>
							<Button size="sm" variant="destructive" onclick={() => requestDelete(vault)}>
								Sil
							</Button>
						</div>
					{/if}
				</div>
			{/each}
		</Card.Content>
	</Card.Root>

	<Card.Root>
		<Card.Header>
			<Card.Title>Yeni vault</Card.Title>
		</Card.Header>
		<Card.Content>
			<div class="flex gap-2">
				<Input
					type="text"
					placeholder="Vault adı"
					bind:value={newVaultName}
					class="max-w-xs"
					onkeydown={(e) => e.key === 'Enter' && createVault()}
				/>
				<Button onclick={createVault}>Oluştur</Button>
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
				<AlertDialog.Title>"{deleteTarget.vault.name}" silinsin mi?</AlertDialog.Title>
				<AlertDialog.Description>
					Kütüphanesi, arama indeksi ve
					{#if deleteTarget.chatCount > 0}
						<strong>{deleteTarget.chatCount} sohbet</strong>
					{:else}
						sohbet geçmişi (yok)
					{/if}
					kalıcı olarak silinecek. Bu işlem geri alınamaz.
				</AlertDialog.Description>
			</AlertDialog.Header>
			{#if deleteError}
				<p class="text-sm text-destructive">{deleteError}</p>
			{/if}
			<AlertDialog.Footer>
				<AlertDialog.Cancel>Vazgeç</AlertDialog.Cancel>
				<AlertDialog.Action
					variant="destructive"
					onclick={(e) => {
						e.preventDefault();
						confirmDelete();
					}}
				>
					Sil
				</AlertDialog.Action>
			</AlertDialog.Footer>
		{/if}
	</AlertDialog.Content>
</AlertDialog.Root>
