<script lang="ts">
	import { goto } from '$app/navigation';
	import type { VaultRecord } from '$lib/types';
	import VaultCard from '$lib/components/VaultCard.svelte';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import * as Dialog from '$lib/components/ui/dialog';
	import SettingsIcon from '@lucide/svelte/icons/settings';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let vaults = $derived<VaultRecord[]>(data.vaults);
	let createOpen = $state(false);
	let newVaultName = $state('');
	let createError = $state('');
	let creating = $state(false);

	async function createVault() {
		const name = newVaultName.trim();
		if (!name) return;
		creating = true;
		createError = '';
		try {
			const res = await fetch('/api/vaults', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ name })
			});
			if (!res.ok) throw new Error((await res.json().catch(() => null))?.message ?? 'Oluşturulamadı');
			const { vault } = (await res.json()) as { vault: VaultRecord };
			// First-ever vault or not, jump straight in — that's the point of
			// just having created it.
			goto(`/vault/${vault.id}`);
		} catch (err) {
			createError = err instanceof Error ? err.message : 'Vault oluşturulamadı.';
			creating = false;
		}
	}
</script>

<svelte:head>
	<title>Vault Agent Toolkit</title>
</svelte:head>

<div class="mx-auto max-w-3xl px-4 pt-10 pb-12">
	<div class="mb-8 flex items-center justify-between">
		<h1 class="font-display text-2xl font-medium">Vault Agent Toolkit</h1>
		<a href="/settings" title="Ayarlar" aria-label="Ayarlar" class="text-muted-foreground hover:text-primary focus-visible:outline-2 focus-visible:outline-[var(--accent)] focus-visible:outline-offset-2">
			<SettingsIcon size={19} aria-hidden="true" />
		</a>
	</div>

	{#if vaults.length === 0}
		<div class="mb-8 flex flex-col items-center gap-2 rounded-lg border border-dashed py-12 text-center">
			<p class="font-display text-lg text-foreground">Henüz bir vault yok</p>
			<p class="max-w-sm text-sm text-muted-foreground">
				Kasandaki notlarla sohbet edebilmek için önce bir vault oluştur — Obsidian kasanı bağlayınca
				içeriği burada aranabilir hale gelir.
			</p>
		</div>
	{/if}

	<div class="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3">
		{#each vaults as vault (vault.id)}
			<VaultCard {vault} />
		{/each}

		<button
			type="button"
			class="flex min-h-[5.5rem] flex-col items-center justify-center gap-1 rounded-xl border border-dashed text-sm text-muted-foreground hover:border-primary hover:text-primary focus-visible:outline-2 focus-visible:outline-[var(--accent)] focus-visible:outline-offset-2"
			onclick={() => (createOpen = true)}
		>
			<PlusIcon size={18} aria-hidden="true" />
			Yeni vault
		</button>
	</div>
</div>

<Dialog.Root bind:open={createOpen}>
	<Dialog.Content class="sm:max-w-sm">
		<Dialog.Header>
			<Dialog.Title>Yeni vault</Dialog.Title>
		</Dialog.Header>
		<label class="flex flex-col gap-1 text-sm">
			Vault adı
			<Input
				type="text"
				bind:value={newVaultName}
				placeholder="örn. Elektronik"
				onkeydown={(e) => e.key === 'Enter' && createVault()}
			/>
		</label>
		{#if createError}
			<p class="text-sm text-destructive">{createError}</p>
		{/if}
		<Dialog.Footer>
			<Button variant="outline" onclick={() => (createOpen = false)}>İptal</Button>
			<Button onclick={createVault} disabled={!newVaultName.trim() || creating}>
				{creating ? 'Oluşturuluyor...' : 'Oluştur'}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
