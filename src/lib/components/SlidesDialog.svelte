<script lang="ts">
	import { settings } from '$lib/settings.svelte';
	import { slidesGeneration, startSlidesGeneration } from '$lib/slides-generation.svelte';
	import type { SlidesGenerationRequest } from '$lib/types';
	import GenerationDialog from './GenerationDialog.svelte';
	import PresentationIcon from '@lucide/svelte/icons/presentation';

	let {
		chatId,
		vaultId,
		includedPaths,
		open = $bindable(false)
	}: { chatId: string; vaultId: string; includedPaths?: string[]; open?: boolean } = $props();

	let alreadyGenerating = $derived(slidesGeneration.items.some((s) => s.phase === 'generating'));

	function generate(args: {
		prompt: string;
		domains?: string[];
		chatId?: string;
		vault: string;
		includedPaths?: string[];
	}) {
		const body: SlidesGenerationRequest = {
			...args,
			model: settings.reasoningModel,
			provider: settings.reasoningProvider
		};
		void startSlidesGeneration(body);
	}
</script>

<GenerationDialog
	{chatId}
	{vaultId}
	{includedPaths}
	bind:open
	icon={PresentationIcon}
	label="Slayt"
	dialogTitle="Slayt Oluştur"
	promptLabel="Sunum hangi konuda olsun?"
	promptPlaceholder="örn. Kernel mimarileri hakkında kısa bir sunum"
	disabled={alreadyGenerating}
	onGenerate={generate}
/>
