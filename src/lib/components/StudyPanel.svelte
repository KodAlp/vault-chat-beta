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
	import type { StudySummary } from '$lib/types';

	/**
	 * Light-version study panel (Faz 9 Adım 6, user-approved simplification):
	 * shows what's already generated/queued, never starts a new generation
	 * itself — that still goes through the existing floating GenerationDialog
	 * per type (Adım 4, untouched here).
	 *
	 * "Recently generated" list added in Faz 13 once quiz/report/mindmap/
	 * slides got list-by-vault endpoints (previously only get-by-id existed,
	 * so a generated item was reachable only via the moment's own
	 * GenerationStatusToast — reload the page or miss that toast and it was
	 * effectively gone even though the row was still sitting in study.db).
	 * Cards intentionally excluded here: there's no per-deck view route
	 * today (cards/ reviews the due queue across every deck at once), so a
	 * clicked deck would have nowhere to navigate to — the due-count badge
	 * below already is cards' persistent status surface.
	 */
	let {
		open = $bindable(false),
		vaultId,
		onOpenQuiz,
		onOpenCards,
		onOpenReport,
		onOpenMindMap,
		onOpenSlides
	}: {
		open?: boolean;
		vaultId: string;
		onOpenQuiz: () => void;
		onOpenCards: () => void;
		onOpenReport: () => void;
		onOpenMindMap: () => void;
		onOpenSlides: () => void;
	} = $props();

	const RECENT_LIMIT = 4;

	let dueCount = $state(0);
	let quizzes = $state<StudySummary[]>([]);
	let reports = $state<StudySummary[]>([]);
	let mindmaps = $state<StudySummary[]>([]);
	let slidedecks = $state<StudySummary[]>([]);

	onMount(() => {
		void refreshDueCount();
		void refreshLists();
	});

	async function refreshDueCount() {
		try {
			const res = await fetch('/api/study/cards/due-count');
			if (res.ok) dueCount = ((await res.json()) as { count: number }).count;
		} catch {
			// row just stays without a badge
		}
	}

	/** Best-effort, independently per type — one failing endpoint (e.g. a
	 * vault with a not-yet-created study.db) must not blank out the other
	 * four lists. */
	async function fetchList(path: string): Promise<StudySummary[]> {
		try {
			const res = await fetch(`${path}?vault=${encodeURIComponent(vaultId)}`);
			if (!res.ok) return [];
			return ((await res.json()) as { items: StudySummary[] }).items;
		} catch {
			return [];
		}
	}

	async function refreshLists() {
		[quizzes, reports, mindmaps, slidedecks] = await Promise.all([
			fetchList('/api/study/quizzes'),
			fetchList('/api/study/reports'),
			fetchList('/api/study/mindmaps'),
			fetchList('/api/study/slidedecks')
		]);
	}

	function trigger(fn: () => void) {
		open = false;
		fn();
	}

	function reviewCards() {
		open = false;
		goto(`/study/cards?vault=${encodeURIComponent(vaultId)}`);
	}

	function openItem(path: string) {
		open = false;
		goto(`${path}?vault=${encodeURIComponent(vaultId)}`);
	}
</script>

<Sheet.Root bind:open>
	<Sheet.Content class="w-80">
		<Sheet.Header>
			<Sheet.Title>Çalışma Paneli</Sheet.Title>
		</Sheet.Header>
		<div class="rows">
			<div class="type-group">
				<div class="row">
					<span class="label"><FileQuestionIcon size={16} aria-hidden="true" /> Test</span>
					<Button variant="outline" size="sm" onclick={() => trigger(onOpenQuiz)}>Yeni</Button>
				</div>
				{#if quizzes.length > 0}
					<ul class="recent-list">
						{#each quizzes.slice(0, RECENT_LIMIT) as item (item.id)}
							<li>
								<button type="button" onclick={() => openItem(`/study/quiz/${item.id}`)}>{item.title}</button>
							</li>
						{/each}
					</ul>
				{/if}
			</div>
			<div class="type-group">
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
			</div>
			<div class="type-group">
				<div class="row">
					<span class="label"><FileTextIcon size={16} aria-hidden="true" /> Rapor</span>
					<Button variant="outline" size="sm" onclick={() => trigger(onOpenReport)}>Yeni</Button>
				</div>
				{#if reports.length > 0}
					<ul class="recent-list">
						{#each reports.slice(0, RECENT_LIMIT) as item (item.id)}
							<li>
								<button type="button" onclick={() => openItem(`/study/report/${item.id}`)}>{item.title}</button>
							</li>
						{/each}
					</ul>
				{/if}
			</div>
			<div class="type-group">
				<div class="row">
					<span class="label"><BrainIcon size={16} aria-hidden="true" /> Harita</span>
					<Button variant="outline" size="sm" onclick={() => trigger(onOpenMindMap)}>Yeni</Button>
				</div>
				{#if mindmaps.length > 0}
					<ul class="recent-list">
						{#each mindmaps.slice(0, RECENT_LIMIT) as item (item.id)}
							<li>
								<button type="button" onclick={() => openItem(`/study/mindmap/${item.id}`)}>{item.title}</button>
							</li>
						{/each}
					</ul>
				{/if}
			</div>
			<div class="type-group">
				<div class="row">
					<span class="label"><PresentationIcon size={16} aria-hidden="true" /> Slayt</span>
					<Button variant="outline" size="sm" onclick={() => trigger(onOpenSlides)}>Yeni</Button>
				</div>
				{#if slidedecks.length > 0}
					<ul class="recent-list">
						{#each slidedecks.slice(0, RECENT_LIMIT) as item (item.id)}
							<li>
								<button type="button" onclick={() => openItem(`/study/slides/${item.id}`)}>{item.title}</button>
							</li>
						{/each}
					</ul>
				{/if}
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

	.type-group {
		border-bottom: 1px solid var(--color-border);
		padding-bottom: 0.35rem;
	}

	.row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		padding: 0.5rem 0;
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

	.recent-list {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		margin: 0 0 0.35rem;
		padding: 0;
		list-style: none;
	}

	.recent-list button {
		display: block;
		width: 100%;
		border: none;
		background: transparent;
		padding: 0.2rem 0.1rem;
		text-align: left;
		font-size: 0.78rem;
		color: var(--color-muted-foreground);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		cursor: pointer;
		border-radius: var(--radius-sm);
	}

	.recent-list button:hover {
		color: var(--color-primary);
	}

	.recent-list button:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}
</style>
