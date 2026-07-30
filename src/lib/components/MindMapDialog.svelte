<script lang="ts">
	import { settings } from '$lib/settings.svelte';
	import { mindmapGeneration, startMindMapGeneration } from '$lib/mindmap-generation.svelte';
	import type { MindMapGenerationRequest } from '$lib/types';
	import GenerationDialog from './GenerationDialog.svelte';

	let { chatId }: { chatId: string } = $props();

	let alreadyGenerating = $derived(mindmapGeneration.status.phase === 'generating');

	function generate(args: { prompt: string; domains?: string[]; chatId?: string }) {
		const body: MindMapGenerationRequest = { ...args, model: settings.reasoningModel };
		void startMindMapGeneration(body);
	}
</script>

<GenerationDialog
	{chatId}
	icon="🧠"
	label="Harita"
	dialogTitle="Zihin Haritası Oluştur"
	promptLabel="Hangi konunun haritası çıkarılsın?"
	promptPlaceholder="örn. SvelteKit routing sisteminin zihin haritası"
	disabled={alreadyGenerating}
	onGenerate={generate}
/>
