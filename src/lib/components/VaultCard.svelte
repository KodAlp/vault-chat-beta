<script lang="ts">
	import type { VaultWithStatus } from '$lib/types';
	import { Badge } from '$lib/components/ui/badge';
	import { i18n, t } from '$lib/i18n/index.svelte';
	import { relativeTime } from '$lib/relative-time';

	let { vault }: { vault: VaultWithStatus } = $props();
</script>

<a
	href="/vault/{vault.id}"
	class="vault-card block no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)]"
>
	<div class="flex h-full min-h-[5.5rem] flex-col gap-1 p-4">
		<span class="truncate text-[17px] leading-[22px] font-semibold tracking-[-0.43px] text-[var(--label)]">{vault.name}</span>
		<span class="text-[13px] leading-[18px] text-[var(--label-secondary)]">{relativeTime(vault.lastOpenedAt, i18n.locale)}</span>
		{#if vault.unindexedCount > 0}
			<Badge
				variant="secondary"
				class="mt-1 w-fit"
				title={t('VaultsSettingsPage.unindexedTitle')}
			>
				{t('VaultsSettingsPage.unindexedBadge', { count: vault.unindexedCount })}
			</Badge>
		{/if}
		{#if vault.embeddingMismatch}
			<Badge variant="secondary" class="mt-1 w-fit" title={t('VaultsSettingsPage.embeddingMismatchTitle')}>
				{t('VaultsSettingsPage.embeddingMismatchBadge')}
			</Badge>
		{/if}
	</div>
</a>

<style>
	.vault-card {
		border-radius: var(--radius-lg);
		background: var(--bg-elevated);
		box-shadow: inset 0 0 0 1px var(--separator);
		transition: background-color var(--duration-fast) cubic-bezier(0.2, 0, 0, 1);
	}

	.vault-card:hover {
		background: var(--bg-elevated);
		box-shadow:
			inset 0 0 0 1px var(--separator-strong),
			inset 0 0 0 999px var(--fill-hover);
	}
</style>
