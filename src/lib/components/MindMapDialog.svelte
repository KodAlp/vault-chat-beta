<script lang="ts">
	import { settings } from '$lib/settings.svelte';
	import { mindmapGeneration, startMindMapGeneration } from '$lib/mindmap-generation.svelte';
	import type { MindMapGenerationRequest } from '$lib/types';
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
		!settings.allowConcurrentGeneration && mindmapGeneration.items.some((s) => s.phase === 'generating')
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
		const body: MindMapGenerationRequest = { ...args };
		void startMindMapGeneration(body);
	}
</script>

<GenerationDialog
	{chatId}
	{vaultId}
	{includedPaths}
	bind:open
	icon="neurology"
	label={t('MindMapDialog.label')}
	dialogTitle={t('MindMapDialog.dialogTitle')}
	promptLabel={t('MindMapDialog.promptLabel')}
	promptPlaceholder={t('MindMapDialog.promptPlaceholder')}
	disabled={alreadyGenerating}
	defaultProvider={settings.reasoningProvider}
	defaultModel={settings.reasoningModel}
	onGenerate={generate}
/>
