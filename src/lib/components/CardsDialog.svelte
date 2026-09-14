<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { settings } from '$lib/settings.svelte';
	import { cardGeneration, startCardGeneration } from '$lib/card-generation.svelte';
	import type { CardGenerationRequest } from '$lib/types';
	import GenerationDialog from './GenerationDialog.svelte';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import LayersIcon from '@lucide/svelte/icons/layers';
	import { t } from '$lib/i18n/index.svelte';

	let {
		chatId,
		vaultId,
		includedPaths,
		open = $bindable(false)
	}: { chatId: string; vaultId: string; includedPaths?: string[]; open?: boolean } = $props();

	let count = $state(10);
	let dueCount = $state(0);

	// Settings' allowConcurrentGeneration (default off) lets a user with
	// stronger hardware queue several generations of the same type at once
	// — when it's on, this just always reads false, so every disabled/
	// canGenerate site below needs no separate change.
	let alreadyGenerating = $derived(
		!settings.allowConcurrentGeneration && cardGeneration.items.some((s) => s.phase === 'generating')
	);

	// The <input max="30"> only stops the spinner arrows — typing a larger
	// number goes straight through it. Clamped on blur, not oninput, so
	// mid-edit keystrokes aren't fought while still typing.
	function clampCount(n: number) {
		return Math.max(1, Math.min(30, Math.round(n) || 1));
	}

	onMount(() => {
		void refreshDueCount();
	});

	async function refreshDueCount() {
		try {
			const res = await fetch('/api/study/cards/due-count');
			if (res.ok) dueCount = ((await res.json()) as { count: number }).count;
		} catch {
			// badge just stays at its last known value
		}
	}

	function review() {
		open = false;
		goto(`/study/cards?vault=${encodeURIComponent(vaultId)}`);
	}

	/** Same reasoning as QuizDialog.svelte's generate(): a real generation
	 * takes 20s-2min, an open dialog for that whole span reads as a frozen
	 * page. */
	function generate(args: {
		prompt: string;
		domains?: string[];
		chatId?: string;
		vault: string;
		includedPaths?: string[];
		provider: string;
		model: string;
	}) {
		const body: CardGenerationRequest = {
			...args,
			count
		};
		void startCardGeneration(body);
	}
</script>

<GenerationDialog
	{chatId}
	{vaultId}
	{includedPaths}
	bind:open
	icon={LayersIcon}
	label={t('CardsDialog.label')}
	dialogTitle={t('CardsDialog.dialogTitle')}
	promptLabel={t('CardsDialog.promptLabel')}
	promptPlaceholder={t('CardsDialog.promptPlaceholder')}
	canGenerate={count > 0 && !alreadyGenerating}
	badge={dueCount || null}
	defaultProvider={settings.reasoningProvider}
	defaultModel={settings.reasoningModel}
	onGenerate={generate}
>
	{#snippet extraTop()}
		{#if dueCount > 0}
			<Button variant="outline" class="w-full border-primary text-primary" onclick={review}>
				{t('CardsDialog.review', { dueCount })}
			</Button>
		{/if}
	{/snippet}
	{#snippet extraFields()}
		<label class="flex w-24 flex-col gap-1 text-sm">
			{t('CardsDialog.cardCount')}
			<Input type="number" min="1" max="30" bind:value={count} onblur={() => (count = clampCount(count))} />
		</label>
	{/snippet}
</GenerationDialog>
