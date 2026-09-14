<script lang="ts">
	import type { VaultRecord } from '$lib/types';
	import * as Card from '$lib/components/ui/card';
	import { i18n } from '$lib/i18n/index.svelte';
	import { relativeTime } from '$lib/relative-time';

	let { vault }: { vault: VaultRecord } = $props();

	/** No source-count field exists on VaultRecord/VaultContext anywhere in
	 * the backend (Faz 8 never added one) — showing it here would require a
	 * new server query, out of scope for this pass. Only name + relative
	 * last-opened time, per the plan's explicit "kapsam dışı" note. */
</script>

<a href="/vault/{vault.id}" class="block no-underline">
	<Card.Root class="h-full transition-colors hover:border-primary">
		<Card.Header>
			<Card.Title class="truncate">{vault.name}</Card.Title>
			<Card.Description>{relativeTime(vault.lastOpenedAt, i18n.locale)}</Card.Description>
		</Card.Header>
	</Card.Root>
</a>
