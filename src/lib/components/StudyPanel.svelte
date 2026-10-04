<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import * as Sheet from '$lib/components/ui/sheet';
	import * as AlertDialog from '$lib/components/ui/alert-dialog';
	import { Badge } from '$lib/components/ui/badge';
	import Icon from '$lib/components/Icon.svelte';
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

{#snippet recent(items: StudySummary[], kind: StudyKind, route: string)}
	{#if items.length > 0}
		<ul class="recent-list">
			{#each items as item (item.id)}
				<li>
					<button type="button" class="item-title" onclick={() => openItem(route + '/' + item.id)}>{item.title}</button>
					<button type="button" class="item-delete" onclick={(e) => askDelete(kind, item.id, item.title, e)} title={t('Common.sil')} aria-label={t('Common.sil')}>
						<Trash2Icon size={14} strokeWidth={1.75} aria-hidden="true" />
					</button>
				</li>
			{/each}
		</ul>
	{/if}
{/snippet}

<Sheet.Root bind:open>
	<Sheet.Content class="vc-root w-[var(--panel-width)] !max-w-[var(--panel-width)] bg-[var(--bg-sidebar)] gap-0" showCloseButton={false}>
		<Sheet.Header class="panel-head">
			<Sheet.Title>{t('StudyPanel.title')}</Sheet.Title>
			<Sheet.Close class="vc-icon-btn" aria-label={t('StudyPanel.close')}>
				<Icon name="panel-right" />
			</Sheet.Close>
		</Sheet.Header>
		<div class="rows">
			<div class="type-group">
				<button type="button" class="vc-action" aria-label={t('StudyPanel.quiz') + ': ' + t('StudyPanel.new')} onclick={() => trigger(onOpenQuiz)}>
					<span class="glyph"><Icon name="neurology" /></span>
					<span class="text"><span class="t">{t('StudyPanel.quiz')}</span><span class="d">{t('StudyPanel.quizDesc')}</span></span>
					<span class="chev"><Icon name="arrow-forward" size="sm" /></span>
				</button>
				{@render recent(quizzes, 'quizzes', '/study/quiz')}
			</div>
			<div class="type-group">
				<button type="button" class="vc-action" aria-label={t('StudyPanel.cards') + ': ' + t('StudyPanel.new')} onclick={() => trigger(onOpenCards)}>
					<span class="glyph"><Icon name="cards-stack" /></span>
					<span class="text">
						<span class="t">
							{t('StudyPanel.cards')}
							{#if dueCount > 0}<Badge variant="secondary">{t('StudyPanel.dueBadge', { count: dueCount })}</Badge>{/if}
						</span>
						<span class="d">{t('StudyPanel.cardsDesc')}</span>
					</span>
					<span class="chev"><Icon name="arrow-forward" size="sm" /></span>
				</button>
				{#if dueCount > 0}
					<div class="due-row">
						<button type="button" class="vc-btn secondary" onclick={reviewCards}>{t('StudyPanel.review')}</button>
					</div>
				{/if}
				{@render recent(decks, 'decks', '/study/cards')}
			</div>
			<div class="type-group">
				<button type="button" class="vc-action" aria-label={t('StudyPanel.report') + ': ' + t('StudyPanel.new')} onclick={() => trigger(onOpenReport)}>
					<span class="glyph"><FileTextIcon size={20} strokeWidth={1.75} aria-hidden="true" /></span>
					<span class="text"><span class="t">{t('StudyPanel.report')}</span><span class="d">{t('StudyPanel.reportDesc')}</span></span>
					<span class="chev"><Icon name="arrow-forward" size="sm" /></span>
				</button>
				{@render recent(reports, 'reports', '/study/report')}
			</div>
			<div class="type-group">
				<button type="button" class="vc-action" aria-label={t('StudyPanel.mindmap') + ': ' + t('StudyPanel.new')} onclick={() => trigger(onOpenMindMap)}>
					<span class="glyph"><BrainIcon size={20} strokeWidth={1.75} aria-hidden="true" /></span>
					<span class="text"><span class="t">{t('StudyPanel.mindmap')}</span><span class="d">{t('StudyPanel.mindmapDesc')}</span></span>
					<span class="chev"><Icon name="arrow-forward" size="sm" /></span>
				</button>
				{@render recent(mindmaps, 'mindmaps', '/study/mindmap')}
			</div>
			<div class="type-group">
				<button type="button" class="vc-action" aria-label={t('StudyPanel.slides') + ': ' + t('StudyPanel.new')} onclick={() => trigger(onOpenSlides)}>
					<span class="glyph"><PresentationIcon size={20} strokeWidth={1.75} aria-hidden="true" /></span>
					<span class="text"><span class="t">{t('StudyPanel.slides')}</span><span class="d">{t('StudyPanel.slidesDesc')}</span></span>
					<span class="chev"><Icon name="arrow-forward" size="sm" /></span>
				</button>
				{@render recent(slidedecks, 'slidedecks', '/study/slides')}
			</div>
			<div class="type-group">
				<button type="button" class="vc-action" aria-label={t('StudyPanel.progress') + ': ' + t('StudyPanel.progressOpen')} onclick={() => openItem('/study/progress')}>
					<span class="glyph"><ChartColumnIcon size={20} strokeWidth={1.75} aria-hidden="true" /></span>
					<span class="text"><span class="t">{t('StudyPanel.progress')}</span><span class="d">{t('StudyPanel.progressDesc')}</span></span>
					<span class="chev"><Icon name="arrow-forward" size="sm" /></span>
				</button>
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
	:global(.panel-head) {
		flex-direction: row;
		align-items: center;
		justify-content: space-between;
		padding: var(--space-4) var(--space-4) var(--space-2);
	}

	.rows {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		padding: var(--space-2) var(--space-4) var(--space-4);
		/* Sheet.Content is a fixed-height flex column; without flex:1 +
		 * min-height:0 this div sizes to its own content and pushes past the
		 * sheet's bottom edge instead of scrolling within it. */
		flex: 1;
		min-height: 0;
		overflow-y: auto;
	}

	.type-group {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	/* .vc-action is designed for a div; as a button it needs the reset. */
	.vc-action {
		appearance: none;
		border: 0;
		width: 100%;
		text-align: left;
		font: inherit;
		color: var(--label);
	}

	.vc-action:focus-visible,
	.item-title:focus-visible,
	.item-delete:focus-visible,
	.due-row .vc-btn:focus-visible {
		outline: 2px solid var(--focus-ring);
		outline-offset: 2px;
	}

	.text {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}

	.text .t {
		display: flex;
		align-items: center;
		gap: var(--space-2);
	}

	.due-row {
		display: flex;
		justify-content: flex-end;
		padding: var(--space-1) var(--space-1) 0;
	}

	.recent-list {
		display: flex;
		flex-direction: column;
		gap: 2px;
		margin: var(--space-1) 0 var(--space-1);
		padding: 0 var(--space-1);
		list-style: none;
	}

	.recent-list li {
		display: flex;
		align-items: center;
		gap: 2px;
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
		padding: 4px 6px;
		text-align: left;
		font: 400 13px/18px var(--font-sans);
		color: var(--label-secondary);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.item-title:hover {
		color: var(--accent-text);
		background: var(--fill-hover);
	}

	.item-delete {
		flex-shrink: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 6px;
		color: var(--label-secondary);
	}

	.item-delete:hover {
		color: var(--danger);
		background: var(--fill-hover);
	}

	@media (prefers-reduced-motion: reduce) {
		.vc-action {
			transition: none;
		}
	}
</style>
