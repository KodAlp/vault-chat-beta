<script lang="ts">
	import { settings } from '$lib/settings.svelte';
	import { quizGeneration, startQuizGeneration } from '$lib/quiz-generation.svelte';
	import type { QuizGenerationRequest } from '$lib/types';
	import GenerationDialog from './GenerationDialog.svelte';
	import { Input } from '$lib/components/ui/input';
	import FileQuestionIcon from '@lucide/svelte/icons/file-question';

	let {
		chatId,
		vaultId,
		includedPaths,
		open = $bindable(false)
	}: { chatId: string; vaultId: string; includedPaths?: string[]; open?: boolean } = $props();

	let mc = $state(6);
	let tf = $state(2);
	let openCount = $state(2);

	let alreadyGenerating = $derived(quizGeneration.items.some((s) => s.phase === 'generating'));

	// The <input max="20"> only stops the spinner arrows — typing "600" goes
	// straight through it. Clamped on blur (not oninput) so mid-edit
	// keystrokes aren't fought while the user is still typing.
	function clampCount(n: number) {
		return Math.max(0, Math.min(20, Math.round(n) || 0));
	}

	/**
	 * Fires the generation request into the shared background store — this
	 * used to await the whole SSE stream inline, blocking the dialog (and
	 * the overlay behind it) open for the 20s-2min a real generation takes,
	 * which read as the page being frozen. Now the request keeps running
	 * regardless of whether this dialog (or even this page) stays open;
	 * QuizGenerationStatus shows live progress elsewhere.
	 */
	function generate(args: {
		prompt: string;
		domains?: string[];
		chatId?: string;
		vault: string;
		includedPaths?: string[];
	}) {
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
	{includedPaths}
	bind:open
	icon={FileQuestionIcon}
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
				<Input type="number" min="0" max="20" bind:value={mc} onblur={() => (mc = clampCount(mc))} class="h-8" />
			</label>
			<label class="flex flex-1 flex-col gap-1 text-xs">
				Doğru/Yanlış
				<Input type="number" min="0" max="20" bind:value={tf} onblur={() => (tf = clampCount(tf))} class="h-8" />
			</label>
			<label class="flex flex-1 flex-col gap-1 text-xs">
				Açık uçlu
				<Input
					type="number"
					min="0"
					max="20"
					bind:value={openCount}
					onblur={() => (openCount = clampCount(openCount))}
					class="h-8"
				/>
			</label>
		</div>
	{/snippet}
</GenerationDialog>
