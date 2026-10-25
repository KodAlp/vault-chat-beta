<script lang="ts">
	import { t } from '$lib/i18n/index.svelte';

	/** Restyle of Message.svelte's old bare `<p class="notice">` — see
	 * the provider fallback policy for when `type: 'notice'`
	 * actually streams (today's single-provider chains never trigger it,
	 * but the mechanism is real, unlike the [LOW]/[HIGH] confidence-tag
	 * idea from the original UI plan, which has no producer anywhere in
	 * prompt.ts and was left unbuilt for that reason). */
	let { message }: { message: string } = $props();
</script>

<div class="vc-banner info fallback-notice">
	<span class="vc-badge">{t('FallbackNotice.badge')}</span>
	<div class="d">{message}</div>
</div>

<style>
	.fallback-notice {
		align-items: center;
		margin: 0 0 var(--space-2);
		padding: var(--space-2) var(--space-3);
	}
</style>
