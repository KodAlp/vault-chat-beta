<script lang="ts">
	import { settings } from '$lib/settings.svelte';
	import { slidesGeneration, startSlidesGeneration } from '$lib/slides-generation.svelte';
	import type { SlidesGenerationRequest } from '$lib/types';
	import GenerationDialog from './GenerationDialog.svelte';

	let { chatId, vaultId }: { chatId: string; vaultId: string } = $props();

	let alreadyGenerating = $derived(slidesGeneration.status.phase === 'generating');

	function generate(args: { prompt: string; domains?: string[]; chatId?: string; vault: string }) {
		const body: SlidesGenerationRequest = { ...args, model: settings.reasoningModel };
		void startSlidesGeneration(body);
	}
</script>

<GenerationDialog
	{chatId}
	{vaultId}
	icon="🖼️"
	label="Slayt"
	dialogTitle="Slayt Oluştur"
	promptLabel="Sunum hangi konuda olsun?"
	promptPlaceholder="örn. Kernel mimarileri hakkında kısa bir sunum"
	disabled={alreadyGenerating}
	onGenerate={generate}
/>
