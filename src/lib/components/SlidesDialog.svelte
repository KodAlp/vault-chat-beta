<script lang="ts">
	import { settings } from '$lib/settings.svelte';
	import { slidesGeneration, startSlidesGeneration } from '$lib/slides-generation.svelte';
	import type { SlidesGenerationRequest } from '$lib/types';
	import GenerationDialog from './GenerationDialog.svelte';
	import { t } from '$lib/i18n/index.svelte';

	let {
		chatId,
		vaultId,
		includedPaths,
		open = $bindable(false)
	}: { chatId: string; vaultId: string; includedPaths?: string[]; open?: boolean } = $props();

	// See CardsDialog.svelte's identical comment on allowConcurrentGeneration.
	let alreadyGenerating = $derived(
		!settings.allowConcurrentGeneration && slidesGeneration.items.some((s) => s.phase === 'generating')
	);

	function generate(args: {
		prompt: string;
		domains?: string[];
		chatId?: string;
		vault: string;
		includedPaths?: string[];
		provider: string;
		model: string;
	}) {
		const body: SlidesGenerationRequest = { ...args };
		void startSlidesGeneration(body);
	}
</script>

<GenerationDialog
	{chatId}
	{vaultId}
	{includedPaths}
	bind:open
	icon="presentation"
	label={t('SlidesDialog.label')}
	dialogTitle={t('SlidesDialog.dialogTitle')}
	promptLabel={t('SlidesDialog.promptLabel')}
	promptPlaceholder={t('SlidesDialog.promptPlaceholder')}
	disabled={alreadyGenerating}
	defaultProvider={settings.reasoningProvider}
	defaultModel={settings.reasoningModel}
	onGenerate={generate}
/>
