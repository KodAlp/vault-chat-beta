<script lang="ts">
	import { settings } from '$lib/settings.svelte';
	import { mindmapGeneration, startMindMapGeneration } from '$lib/mindmap-generation.svelte';
	import type { MindMapGenerationRequest } from '$lib/types';
	import GenerationDialog from './GenerationDialog.svelte';
	import BrainIcon from '@lucide/svelte/icons/brain';
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
	}) {
		const body: MindMapGenerationRequest = {
			...args,
			model: settings.reasoningModel,
			provider: settings.reasoningProvider
		};
		void startMindMapGeneration(body);
	}
</script>

<GenerationDialog
	{chatId}
	{vaultId}
	{includedPaths}
	bind:open
	icon={BrainIcon}
	label={t('MindMapDialog.label')}
	dialogTitle={t('MindMapDialog.dialogTitle')}
	promptLabel={t('MindMapDialog.promptLabel')}
	promptPlaceholder={t('MindMapDialog.promptPlaceholder')}
	disabled={alreadyGenerating}
	onGenerate={generate}
/>
