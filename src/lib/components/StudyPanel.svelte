<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import * as Sheet from '$lib/components/ui/sheet';
	import * as AlertDialog from '$lib/components/ui/alert-dialog';
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import FileQuestionIcon from '@lucide/svelte/icons/file-question';
	import LayersIcon from '@lucide/svelte/icons/layers';
	import FileTextIcon from '@lucide/svelte/icons/file-text';
	import BrainIcon from '@lucide/svelte/icons/brain';
	import PresentationIcon from '@lucide/svelte/icons/presentation';
	import ChartColumnIcon from '@lucide/svelte/icons/chart-column';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import type { StudySummary } from '$lib/types';
	import { t } from '$lib/i18n/index.svelte';

	type StudyKind = 'quizzes' | 'reports' | 'mindmaps' | 'slidedecks' | 'decks';

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
	 * Decks joined this list once /study/cards/[id] existed to navigate a
	 * clicked deck to (previously excluded — see study-db.ts's getDeckCards
	 * doc comment for the fix) — the due-count badge stays as cards'
	 * additional cross-deck status surface, it doesn't replace the list.
	 */
	let {
		open = $bindable(false),
		vaultId,
		onOpenQuiz,
		onOpenCards,
		onOpenReport,
		onOpenMindMap,
		onOpenSlides,
		onUnseenChange
	}: {
		open?: boolean;
		vaultId: string;
		onOpenQuiz: () => void;
		onOpenCards: () => void;
		onOpenReport: () => void;
		onOpenMindMap: () => void;
		onOpenSlides: () => void;
		/** Fires whenever "is there generated material the user hasn't seen
		 * yet" changes — the caller (the chat screen) uses it to show/hide a
		 * dot on ITS OWN "Panel" trigger button, since that button lives
		 * outside this component (see StudyPanel's doc comment: this is a
		 * Sheet, not the button that opens it). */
		onUnseenChange?: (unseen: boolean) => void;
	} = $props();

	let dueCount = $state(0);
	let quizzes = $state<StudySummary[]>([]);
	let decks = $state<StudySummary[]>([]);
	let reports = $state<StudySummary[]>([]);
	let mindmaps = $state<StudySummary[]>([]);
	let slidedecks = $state<StudySummary[]>([]);

	/**
	 * "Unseen" tracking (Faz 18): a per-vault localStorage timestamp of the
	 * newest generated item the user has actually looked at (opened the
	 * panel for). Decks count toward this now, same as the other four types.
	 */
	function unseenStorageKey(): string {
		return `vault-chat-study-panel-last-seen:${vaultId}`;
	}

	function loadLastSeenAt(): number {
		if (typeof localStorage === 'undefined') return 0;
		return Number(localStorage.getItem(unseenStorageKey())) || 0;
	}

	let lastSeenAt = $state(loadLastSeenAt());

	function newestCreatedAt(items: StudySummary[]): number {
		return items.reduce((max, item) => Math.max(max, Date.parse(item.createdAt) || 0), 0);
	}

	let newestItemAt = $derived(
		Math.max(
			newestCreatedAt(quizzes),
			newestCreatedAt(decks),
			newestCreatedAt(reports),
			newestCreatedAt(mindmaps),
			newestCreatedAt(slidedecks)
		)
	);
	let hasUnseen = $derived(newestItemAt > lastSeenAt);

	$effect(() => {
		onUnseenChange?.(hasUnseen);
	});

	// Opening the panel is what "marks as seen" (per the feature spec: the
	// dot disappears after viewing) — refresh first so a generation that
	// completed while the panel was closed is actually reflected in
	// newestItemAt before it gets snapshotted into lastSeenAt, not just
	// whatever was already loaded at mount time.
	let wasOpen = false;
	$effect(() => {
		if (open && !wasOpen) void markSeen();
		wasOpen = open;
	});

	async function markSeen() {
		await refreshLists();
		lastSeenAt = newestItemAt;
		if (typeof localStorage !== 'undefined') {
			localStorage.setItem(unseenStorageKey(), String(lastSeenAt));
		}
	}

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
		[quizzes, decks, reports, mindmaps, slidedecks] = await Promise.all([
			fetchList('/api/study/quizzes'),
			fetchList('/api/study/decks'),
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
		// Same `from` treatment as openItem below — this button used to skip
		// it since it isn't built from openItem's shared path.
		const params = new URLSearchParams({ vault: vaultId, from: page.url.pathname + page.url.search });
		goto(`/study/cards?${params.toString()}`);
	}

	function openItem(path: string) {
		open = false;
		// from: the chat screen this panel is opened from — see
		// back-link.ts. Without it, the study page's own back link had
		// nothing to return to but a hardcoded home link.
		const params = new URLSearchParams({ vault: vaultId, from: page.url.pathname + page.url.search });
		goto(`${path}?${params.toString()}`);
	}

	let confirmingDelete = $state<{ kind: StudyKind; id: string; title: string } | null>(null);

	function askDelete(kind: StudyKind, id: string, title: string, e: MouseEvent) {
		e.stopPropagation();
		confirmingDelete = { kind, id, title };
	}

	async function confirmDelete() {
		if (!confirmingDelete) return;
		const { kind, id } = confirmingDelete;
		confirmingDelete = null;
		try {
			await fetch(`/api/study/${kind}/${id}`, {
				method: 'DELETE',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ vault: vaultId })
			});
		} finally {
			void refreshLists();
		}
	}
</script>

<Sheet.Root bind:open>
	<Sheet.Content class="w-80">
		<Sheet.Header>
			<Sheet.Title>{t('StudyPanel.title')}</Sheet.Title>
		</Sheet.Header>
		<div class="rows">
			<div class="type-group">
				<div class="row">
					<span class="label"><FileQuestionIcon size={16} aria-hidden="true" /> {t('StudyPanel.quiz')}</span>
					<Button variant="outline" size="sm" onclick={() => trigger(onOpenQuiz)}>{t('StudyPanel.new')}</Button>
				</div>
				{#if quizzes.length > 0}
					<ul class="recent-list">
						{#each quizzes as item (item.id)}
							<li>
								<button type="button" class="item-title" onclick={() => openItem(`/study/quiz/${item.id}`)}>{item.title}</button>
								<button type="button" class="item-delete" onclick={(e) => askDelete('quizzes', item.id, item.title, e)} title={t('Common.sil')} aria-label={t('Common.sil')}>
									<Trash2Icon size={12} aria-hidden="true" />
								</button>
							</li>
						{/each}
					</ul>
				{/if}
			</div>
			<div class="type-group">
				<div class="row">
					<span class="label">
						<LayersIcon size={16} aria-hidden="true" /> {t('StudyPanel.cards')}
						{#if dueCount > 0}<Badge variant="secondary">{t('StudyPanel.dueBadge', { count: dueCount })}</Badge>{/if}
					</span>
					<div class="row-actions">
						{#if dueCount > 0}
							<Button variant="outline" size="sm" onclick={reviewCards}>{t('StudyPanel.review')}</Button>
						{/if}
						<Button variant="outline" size="sm" onclick={() => trigger(onOpenCards)}>{t('StudyPanel.new')}</Button>
					</div>
				</div>
				{#if decks.length > 0}
					<ul class="recent-list">
						{#each decks as item (item.id)}
							<li>
								<button type="button" class="item-title" onclick={() => openItem(`/study/cards/${item.id}`)}>{item.title}</button>
								<button type="button" class="item-delete" onclick={(e) => askDelete('decks', item.id, item.title, e)} title={t('Common.sil')} aria-label={t('Common.sil')}>
									<Trash2Icon size={12} aria-hidden="true" />
								</button>
							</li>
						{/each}
					</ul>
				{/if}
			</div>
			<div class="type-group">
				<div class="row">
					<span class="label"><FileTextIcon size={16} aria-hidden="true" /> {t('StudyPanel.report')}</span>
					<Button variant="outline" size="sm" onclick={() => trigger(onOpenReport)}>{t('StudyPanel.new')}</Button>
				</div>
				{#if reports.length > 0}
					<ul class="recent-list">
						{#each reports as item (item.id)}
							<li>
								<button type="button" class="item-title" onclick={() => openItem(`/study/report/${item.id}`)}>{item.title}</button>
								<button type="button" class="item-delete" onclick={(e) => askDelete('reports', item.id, item.title, e)} title={t('Common.sil')} aria-label={t('Common.sil')}>
									<Trash2Icon size={12} aria-hidden="true" />
								</button>
							</li>
						{/each}
					</ul>
				{/if}
			</div>
			<div class="type-group">
				<div class="row">
					<span class="label"><BrainIcon size={16} aria-hidden="true" /> {t('StudyPanel.mindmap')}</span>
					<Button variant="outline" size="sm" onclick={() => trigger(onOpenMindMap)}>{t('StudyPanel.new')}</Button>
				</div>
				{#if mindmaps.length > 0}
					<ul class="recent-list">
						{#each mindmaps as item (item.id)}
							<li>
								<button type="button" class="item-title" onclick={() => openItem(`/study/mindmap/${item.id}`)}>{item.title}</button>
								<button type="button" class="item-delete" onclick={(e) => askDelete('mindmaps', item.id, item.title, e)} title={t('Common.sil')} aria-label={t('Common.sil')}>
									<Trash2Icon size={12} aria-hidden="true" />
								</button>
							</li>
						{/each}
					</ul>
				{/if}
			</div>
			<div class="type-group">
				<div class="row">
					<span class="label"><PresentationIcon size={16} aria-hidden="true" /> {t('StudyPanel.slides')}</span>
					<Button variant="outline" size="sm" onclick={() => trigger(onOpenSlides)}>{t('StudyPanel.new')}</Button>
				</div>
				{#if slidedecks.length > 0}
					<ul class="recent-list">
						{#each slidedecks as item (item.id)}
							<li>
								<button type="button" class="item-title" onclick={() => openItem(`/study/slides/${item.id}`)}>{item.title}</button>
								<button type="button" class="item-delete" onclick={(e) => askDelete('slidedecks', item.id, item.title, e)} title={t('Common.sil')} aria-label={t('Common.sil')}>
									<Trash2Icon size={12} aria-hidden="true" />
								</button>
							</li>
						{/each}
					</ul>
				{/if}
			</div>
			<div class="type-group">
				<div class="row">
					<span class="label"><ChartColumnIcon size={16} aria-hidden="true" /> {t('StudyPanel.progress')}</span>
					<div class="row-actions">
						<Button variant="outline" size="sm" onclick={() => openItem('/study/progress')}>{t('StudyPanel.progressOpen')}</Button>
					</div>
				</div>
			</div>
		</div>
	</Sheet.Content>
</Sheet.Root>

<AlertDialog.Root open={confirmingDelete !== null} onOpenChange={(next) => { if (!next) confirmingDelete = null; }}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>{t('StudyPanel.deleteConfirmTitle', { title: confirmingDelete?.title ?? '' })}</AlertDialog.Title>
			<AlertDialog.Description>{t('Common.buIslemGeriAlinamaz')}</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>{t('Common.vazgec')}</AlertDialog.Cancel>
			<AlertDialog.Action
				variant="destructive"
				onclick={(e) => {
					e.preventDefault();
					confirmDelete();
				}}
			>
				{t('Common.sil')}
			</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>

<style>
	.rows {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		padding: 0 1rem 1rem;
		/* Sheet.Content is a fixed-height flex column (Sheet.Header above
		 * this); without flex:1 + min-height:0 this div sizes to its own
		 * content and pushes past the sheet's bottom edge instead of
		 * scrolling within it — same pattern as Chat.svelte's
		 * .messages-wrap/.messages. Every list below used to hard-cut at 4
		 * items (RECENT_LIMIT) specifically because nothing here could
		 * scroll; now the lists show everything and this is what makes
		 * "everything" reachable instead of just taller than the sheet. */
		flex: 1;
		min-height: 0;
		overflow-y: auto;
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

	.recent-list li {
		display: flex;
		align-items: center;
		gap: 0.15rem;
	}

	.recent-list button {
		border: none;
		background: transparent;
		cursor: pointer;
		border-radius: var(--radius-sm);
	}

	.item-title {
		flex: 1;
		min-width: 0;
		display: block;
		padding: 0.2rem 0.1rem;
		text-align: left;
		font-size: 0.78rem;
		color: var(--color-muted-foreground);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.item-title:hover {
		color: var(--color-primary);
	}

	.item-delete {
		flex-shrink: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 0.2rem;
		color: var(--color-muted-foreground);
	}

	.item-delete:hover {
		color: var(--color-destructive);
	}

	.recent-list button:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}
</style>
