<script lang="ts">
	import { Badge } from '$lib/components/ui/badge';

	/** Restyle of Message.svelte's old bare `<p class="notice">` — see the
	 * model-provider skill's fallback policy for when `type: 'notice'`
	 * actually streams (today's single-provider chains never trigger it,
	 * but the mechanism is real, unlike the [LOW]/[HIGH] confidence-tag
	 * idea from the original UI-PLAN, which has no producer anywhere in
	 * prompt.ts and was left unbuilt for that reason — see Faz 9 Adım 6). */
	let { message }: { message: string } = $props();
</script>

<p class="fallback-notice">
	<Badge variant="outline" class="px-1.5 text-[0.6875rem] font-normal">sistem</Badge>
	{message}
</p>

<style>
	.fallback-notice {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		font-size: 0.75rem;
		color: var(--color-muted-foreground);
		margin: 0 0 0.3rem;
	}
</style>
