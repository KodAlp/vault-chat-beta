<script lang="ts">
	import { settings } from '$lib/settings.svelte';
	import { mindmapGeneration, startMindMapGeneration } from '$lib/mindmap-generation.svelte';
	import type { MindMapGenerationRequest } from '$lib/types';
	import GenerationDialog from './GenerationDialog.svelte';

	let {
		chatId,
		vaultId,
		open = $bindable(false)
	}: { chatId: string; vaultId: string; open?: boolean } = $props();

	let alreadyGenerating = $derived(mindmapGeneration.status.phase === 'generating');

	function generate(args: { prompt: string; domains?: string[]; chatId?: string; vault: string }) {
		const body: MindMapGenerationRequest = { ...args, model: settings.reasoningModel };
		void startMindMapGeneration(body);
	}
</script>

<GenerationDialog
	{chatId}
	{vaultId}
	bind:open
	icon="🧠"
	label="Harita"
	dialogTitle="Zihin Haritası Oluştur"
	promptLabel="Hangi konunun haritası çıkarılsın?"
	promptPlaceholder="örn. SvelteKit routing sisteminin zihin haritası"
	disabled={alreadyGenerating}
	onGenerate={generate}
/>
