<script lang="ts">
	import { settings } from '$lib/settings.svelte';
	import { quizGeneration, startQuizGeneration } from '$lib/quiz-generation.svelte';
	import type { QuizGenerationRequest } from '$lib/types';
	import GenerationDialog from './GenerationDialog.svelte';
	import { Input } from '$lib/components/ui/input';
	import FileQuestionIcon from '@lucide/svelte/icons/file-question';
	import { t } from '$lib/i18n/index.svelte';

	let {
		chatId,
		vaultId,
		includedPaths,
		open = $bindable(false)
	}: { chatId: string; vaultId: string; includedPaths?: string[]; open?: boolean } = $props();

	let mc = $state(6);
	let tf = $state(2);
	let openCount = $state(2);

	// See CardsDialog.svelte's identical comment on allowConcurrentGeneration.
	let alreadyGenerating = $derived(
		!settings.allowConcurrentGeneration && quizGeneration.items.some((s) => s.phase === 'generating')
	);

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
		provider: string;
		model: string;
	}) {
		const body: QuizGenerationRequest = {
			...args,
			composition: { mc, tf, open: openCount }
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
	label={t('QuizDialog.label')}
	dialogTitle={t('QuizDialog.dialogTitle')}
	promptLabel={t('QuizDialog.promptLabel')}
	promptPlaceholder={t('QuizDialog.promptPlaceholder')}
	disabled={alreadyGenerating}
	canGenerate={mc + tf + openCount > 0}
	defaultProvider={settings.reasoningProvider}
	defaultModel={settings.reasoningModel}
	onGenerate={generate}
>
	{#snippet extraFields()}
		<div class="flex gap-3">
			<label class="flex flex-1 flex-col gap-1 text-xs">
				{t('QuizDialog.multipleChoice')}
				<Input type="number" min="0" max="20" bind:value={mc} onblur={() => (mc = clampCount(mc))} class="h-8" />
			</label>
			<label class="flex flex-1 flex-col gap-1 text-xs">
				{t('QuizDialog.trueFalse')}
				<Input type="number" min="0" max="20" bind:value={tf} onblur={() => (tf = clampCount(tf))} class="h-8" />
			</label>
			<label class="flex flex-1 flex-col gap-1 text-xs">
				{t('QuizDialog.openEnded')}
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
