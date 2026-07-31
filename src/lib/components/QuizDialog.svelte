<script lang="ts">
	import { settings } from '$lib/settings.svelte';
	import { quizGeneration, startQuizGeneration } from '$lib/quiz-generation.svelte';
	import type { QuizGenerationRequest } from '$lib/types';
	import GenerationDialog from './GenerationDialog.svelte';
	import { Input } from '$lib/components/ui/input';

	let {
		chatId,
		vaultId,
		open = $bindable(false)
	}: { chatId: string; vaultId: string; open?: boolean } = $props();

	let mc = $state(6);
	let tf = $state(2);
	let openCount = $state(2);

	let alreadyGenerating = $derived(quizGeneration.status.phase === 'generating');

	/**
	 * Fires the generation request into the shared background store — this
	 * used to await the whole SSE stream inline, blocking the dialog (and
	 * the overlay behind it) open for the 20s-2min a real generation takes,
	 * which read as the page being frozen. Now the request keeps running
	 * regardless of whether this dialog (or even this page) stays open;
	 * QuizGenerationStatus shows live progress elsewhere.
	 */
	function generate(args: { prompt: string; domains?: string[]; chatId?: string; vault: string }) {
		const body: QuizGenerationRequest = {
			...args,
			composition: { mc, tf, open: openCount },
			model: settings.reasoningModel
		};
		void startQuizGeneration(body);
	}
</script>

<GenerationDialog
	{chatId}
	{vaultId}
	bind:open
	icon="📝"
	label="Test"
	dialogTitle="Test Oluştur"
	promptLabel="Ne tür bir test istiyorsun?"
	promptPlaceholder="örn. Türev ve limit kavramları üzerine orta zorlukta bir test"
	disabled={alreadyGenerating}
	canGenerate={mc + tf + openCount > 0}
	onGenerate={generate}
>
	{#snippet extraFields()}
		<div class="flex gap-3">
			<label class="flex flex-1 flex-col gap-1 text-xs">
				Çoktan seçmeli
				<Input type="number" min="0" max="20" bind:value={mc} class="h-8" />
			</label>
			<label class="flex flex-1 flex-col gap-1 text-xs">
				Doğru/Yanlış
				<Input type="number" min="0" max="20" bind:value={tf} class="h-8" />
			</label>
			<label class="flex flex-1 flex-col gap-1 text-xs">
				Açık uçlu
				<Input type="number" min="0" max="20" bind:value={openCount} class="h-8" />
			</label>
		</div>
	{/snippet}
</GenerationDialog>
