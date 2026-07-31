<script lang="ts">
	import type { VaultRecord } from '$lib/types';
	import * as Card from '$lib/components/ui/card';

	let { vault }: { vault: VaultRecord } = $props();

	/** No source-count field exists on VaultRecord/VaultContext anywhere in
	 * the backend (Faz 8 never added one) — showing it here would require a
	 * new server query, out of scope for this pass. Only name + relative
	 * last-opened time, per the plan's explicit "kapsam dışı" note. */
	function relativeTime(iso: string): string {
		const rtf = new Intl.RelativeTimeFormat('tr', { numeric: 'auto' });
		const diffMin = Math.round((new Date(iso).getTime() - Date.now()) / 60_000);
		if (Math.abs(diffMin) < 60) return rtf.format(diffMin, 'minute');
		const diffHour = Math.round(diffMin / 60);
		if (Math.abs(diffHour) < 24) return rtf.format(diffHour, 'hour');
		const diffDay = Math.round(diffHour / 24);
		return rtf.format(diffDay, 'day');
	}
</script>

<a href="/vault/{vault.id}" class="block no-underline">
	<Card.Root class="h-full transition-colors hover:border-primary">
		<Card.Header>
			<Card.Title class="truncate">{vault.name}</Card.Title>
			<Card.Description>{relativeTime(vault.lastOpenedAt)}</Card.Description>
		</Card.Header>
	</Card.Root>
</a>
