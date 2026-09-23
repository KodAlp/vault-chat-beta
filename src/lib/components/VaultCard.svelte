<script lang="ts">
	import type { VaultWithStatus } from '$lib/types';
	import * as Card from '$lib/components/ui/card';
	import { Badge } from '$lib/components/ui/badge';
	import { i18n, t } from '$lib/i18n/index.svelte';
	import { relativeTime } from '$lib/relative-time';

	let { vault }: { vault: VaultWithStatus } = $props();
</script>

<a href="/vault/{vault.id}" class="block no-underline">
	<Card.Root class="h-full transition-colors hover:border-primary">
		<Card.Header>
			<Card.Title class="truncate">{vault.name}</Card.Title>
			<Card.Description>{relativeTime(vault.lastOpenedAt, i18n.locale)}</Card.Description>
			{#if vault.unindexedCount > 0}
				<Badge
					variant="outline"
					class="mt-1 w-fit"
					title={t('VaultsSettingsPage.unindexedTitle', { id: vault.id })}
				>
					{t('VaultsSettingsPage.unindexedBadge', { count: vault.unindexedCount })}
				</Badge>
			{/if}
		</Card.Header>
	</Card.Root>
</a>
