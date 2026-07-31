<script lang="ts">
	import { settings } from '$lib/settings.svelte';
	import { reportGeneration, startReportGeneration } from '$lib/report-generation.svelte';
	import type { ReportGenerationRequest } from '$lib/types';
	import GenerationDialog from './GenerationDialog.svelte';

	let { chatId, vaultId }: { chatId: string; vaultId: string } = $props();

	let alreadyGenerating = $derived(reportGeneration.status.phase === 'generating');

	function generate(args: { prompt: string; domains?: string[]; chatId?: string; vault: string }) {
		const body: ReportGenerationRequest = { ...args, model: settings.reasoningModel };
		void startReportGeneration(body);
	}
</script>

<GenerationDialog
	{chatId}
	{vaultId}
	icon="📄"
	label="Rapor"
	dialogTitle="Rapor Oluştur"
	promptLabel="Rapor hangi konuda olsun?"
	promptPlaceholder="örn. SvelteKit'te routing ve form action'ların nasıl çalıştığına dair kapsamlı bir rapor"
	disabled={alreadyGenerating}
	onGenerate={generate}
/>
