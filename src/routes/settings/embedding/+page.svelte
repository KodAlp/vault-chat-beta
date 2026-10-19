<script lang="ts">
	import { onMount } from 'svelte';
	import type { ProviderStatus } from '$lib/types';
	import EmbeddingSettingsCard from '$lib/components/EmbeddingSettingsCard.svelte';
	import RerankerSettingsCard from '$lib/components/RerankerSettingsCard.svelte';
	import { t } from '$lib/i18n/index.svelte';

	let providers = $state<ProviderStatus[]>([]);
	let loadError = $state('');

	// Same source the providers page uses: the card's provider select lists the
	// enabled ollama/openai-compat providers from this array.
	onMount(async () => {
		try {
			const res = await fetch('/api/providers');
			if (!res.ok) throw new Error();
			providers = (await res.json()) as ProviderStatus[];
		} catch {
			loadError = t('ProvidersSettingsPage.loadError');
		}
	});
</script>

<svelte:head>
	<title>{t('SettingsNav.embedding')} — Vault Chat</title>
</svelte:head>

<div class="flex flex-col gap-4">
	<p class="text-sm text-muted-foreground">{t('EmbeddingSettingsPage.intro')}</p>
	{#if loadError}
		<p class="text-sm text-destructive" role="alert">{loadError}</p>
	{/if}
	<EmbeddingSettingsCard {providers} />
	<RerankerSettingsCard />
</div>
