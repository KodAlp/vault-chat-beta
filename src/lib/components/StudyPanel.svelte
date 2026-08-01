<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import * as Sheet from '$lib/components/ui/sheet';
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import FileQuestionIcon from '@lucide/svelte/icons/file-question';
	import LayersIcon from '@lucide/svelte/icons/layers';
	import FileTextIcon from '@lucide/svelte/icons/file-text';
	import BrainIcon from '@lucide/svelte/icons/brain';
	import PresentationIcon from '@lucide/svelte/icons/presentation';

	/**
	 * Light-version study panel (Faz 9 Adım 6, user-approved simplification):
	 * shows what's already generated/queued, never starts a new generation
	 * itself — that still goes through the existing floating GenerationDialog
	 * per type (Adım 4, untouched here). No "recently generated" list: quiz/
	 * report/mindmap/slides have no list-by-vault endpoint today (only
	 * get-by-id), and adding one was explicitly out of scope for this pass —
	 * only cards has a due-queue concept, so it's the only type with real
	 * status to show.
	 */
	let {
		open = $bindable(false),
		onOpenQuiz,
		onOpenCards,
		onOpenReport,
		onOpenMindMap,
		onOpenSlides
	}: {
		open?: boolean;
		onOpenQuiz: () => void;
		onOpenCards: () => void;
		onOpenReport: () => void;
		onOpenMindMap: () => void;
		onOpenSlides: () => void;
	} = $props();

	let dueCount = $state(0);

	onMount(() => {
		void refreshDueCount();
	});

	async function refreshDueCount() {
		try {
			const res = await fetch('/api/study/cards/due-count');
			if (res.ok) dueCount = ((await res.json()) as { count: number }).count;
		} catch {
			// row just stays without a badge
		}
	}

	function trigger(fn: () => void) {
		open = false;
		fn();
	}

	function reviewCards() {
		open = false;
		goto('/study/cards');
	}
</script>

<Sheet.Root bind:open>
	<Sheet.Content class="w-80">
		<Sheet.Header>
			<Sheet.Title>Çalışma Paneli</Sheet.Title>
		</Sheet.Header>
		<div class="rows">
			<div class="row">
				<span class="label"><FileQuestionIcon size={16} aria-hidden="true" /> Test</span>
				<Button variant="outline" size="sm" onclick={() => trigger(onOpenQuiz)}>Yeni</Button>
			</div>
			<div class="row">
				<span class="label">
					<LayersIcon size={16} aria-hidden="true" /> Kartlar
					{#if dueCount > 0}<Badge variant="secondary">{dueCount} bekliyor</Badge>{/if}
				</span>
				<div class="row-actions">
					{#if dueCount > 0}
						<Button variant="outline" size="sm" onclick={reviewCards}>İncele</Button>
					{/if}
					<Button variant="outline" size="sm" onclick={() => trigger(onOpenCards)}>Yeni</Button>
				</div>
			</div>
			<div class="row">
				<span class="label"><FileTextIcon size={16} aria-hidden="true" /> Rapor</span>
				<Button variant="outline" size="sm" onclick={() => trigger(onOpenReport)}>Yeni</Button>
			</div>
			<div class="row">
				<span class="label"><BrainIcon size={16} aria-hidden="true" /> Harita</span>
				<Button variant="outline" size="sm" onclick={() => trigger(onOpenMindMap)}>Yeni</Button>
			</div>
			<div class="row">
				<span class="label"><PresentationIcon size={16} aria-hidden="true" /> Slayt</span>
				<Button variant="outline" size="sm" onclick={() => trigger(onOpenSlides)}>Yeni</Button>
			</div>
		</div>
	</Sheet.Content>
</Sheet.Root>

<style>
	.rows {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		padding: 0 1rem 1rem;
	}

	.row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		padding: 0.5rem 0;
		border-bottom: 1px solid var(--color-border);
	}

	.label {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		font-size: 0.85rem;
	}

	.row-actions {
		display: flex;
		gap: 0.35rem;
	}
</style>
