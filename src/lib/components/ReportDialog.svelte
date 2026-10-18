<script lang="ts">
	import { settings } from '$lib/settings.svelte';
	import { reportGeneration, startReportGeneration } from '$lib/report-generation.svelte';
	import type { ReportGenerationRequest } from '$lib/types';
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
		!settings.allowConcurrentGeneration && reportGeneration.items.some((s) => s.phase === 'generating')
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
		const body: ReportGenerationRequest = { ...args };
		void startReportGeneration(body);
	}
</script>

<GenerationDialog
	{chatId}
	{vaultId}
	{includedPaths}
	bind:open
	icon="file-text"
	label={t('ReportDialog.label')}
	dialogTitle={t('ReportDialog.dialogTitle')}
	promptLabel={t('ReportDialog.promptLabel')}
	promptPlaceholder={t('ReportDialog.promptPlaceholder')}
	disabled={alreadyGenerating}
	defaultProvider={settings.reasoningProvider}
	defaultModel={settings.reasoningModel}
	onGenerate={generate}
/>
