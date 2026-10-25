<script lang="ts">
	import Icon from '#lib/components/Icon.svelte';
	import { goto } from '$app/navigation';
	import { motionFly } from '#lib/motion.js';
	import type { VaultRecord, VaultWithStatus } from '#lib/types.js';
	import VaultCard from '#lib/components/VaultCard.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import { t } from '#lib/i18n/index.svelte.js';
	import { readResponseError } from '#lib/server-error.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let vaults = $derived<VaultWithStatus[]>(data.vaults);
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
			if (!res.ok) {
				createError = await readResponseError(res);
				creating = false;
				return;
			}
			const { vault } = (await res.json()) as { vault: VaultRecord };
			// First-ever vault or not, jump straight in — that's the point of
			// just having created it.
			goto(`/vault/${vault.id}`);
		} catch {
			createError = t('HomePage.createFailed');
			creating = false;
		}
	}
</script>

<svelte:head>
	<title>{t('HomePage.title')}</title>
</svelte:head>

<div class="mx-auto max-w-3xl px-4 pt-10 pb-12">
	<div class="mb-8 flex items-start justify-between gap-4">
		<h1 class="text-display-hero m-0" style="letter-spacing: -0.45px;">{t('HomePage.title')}</h1>
		<a
			href="/settings"
			title={t('Common.ayarlar')}
			aria-label={t('Common.ayarlar')}
			class="vc-icon-btn shrink-0 focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)] focus-visible:outline-offset-2"
		>
			<Icon name="settings" />
		</a>
	</div>

	{#if vaults.length === 0}
		<div class="vc-empty mb-8" style="padding-block: var(--space-8);">
			<p class="text-[22px] leading-7 font-semibold text-[var(--label)]">{t('HomePage.emptyTitle')}</p>
			<p>{t('HomePage.emptyDescription')}</p>
		</div>
	{/if}

	<div class="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3">
		{#each vaults as vault, i (vault.id)}
			<div in:motionFly={{ y: 8, delay: Math.min(i * 30, 150) }}>
				<VaultCard {vault} />
			</div>
		{/each}
	</div>

	<div class="mt-6">
		<Button size="lg" onclick={() => (createOpen = true)}>
			<Icon name="plus" />
			{t('HomePage.newVault')}
		</Button>
	</div>
</div>

<Dialog.Root bind:open={createOpen}>
	<Dialog.Content class="sm:max-w-sm">
		<Dialog.Header>
			<Dialog.Title>{t('HomePage.newVaultDialogTitle')}</Dialog.Title>
		</Dialog.Header>
		<label class="flex flex-col gap-1.5 text-[13px] leading-[18px] font-medium">
			{t('HomePage.vaultNameLabel')}
			<Input
				type="text"
				bind:value={newVaultName}
				placeholder={t('HomePage.vaultNamePlaceholder')}
				onkeydown={(e) => e.key === 'Enter' && createVault()}
			/>
		</label>
		{#if createError}
			<p class="text-[13px] leading-[18px] text-destructive">{createError}</p>
		{/if}
		<Dialog.Footer>
			<Button variant="secondary" onclick={() => (createOpen = false)}>{t('Common.iptal')}</Button>
			<Button onclick={createVault} disabled={!newVaultName.trim()} loading={creating}>
				{creating ? t('HomePage.creating') : t('HomePage.create')}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
