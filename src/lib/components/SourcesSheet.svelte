<script lang="ts" module>
	export type SourceCounts = {
		selected: number;
		total: number;
		areasSelected: number;
		areasTotal: number;
	};
</script>

<script lang="ts">
	import { onMount } from 'svelte';
	import { Dialog as DialogPrimitive } from 'bits-ui';
	import type { LibraryNode, LibrarySettings } from '$lib/types';
	import {
		applyDisplayRules,
		collectFilePaths,
		toggleNode,
		toIncludedPaths,
		selectOnly,
		selectedAreas
	} from '$lib/sourceTree';
	import * as Sheet from '$lib/components/ui/sheet';
	import * as AlertDialog from '$lib/components/ui/alert-dialog';
	import SourceTree from './SourceTree.svelte';
	import XIcon from '@lucide/svelte/icons/x';
	import { t } from '$lib/i18n/index.svelte';

	/**
	 * The source-scope picker: a large centered sheet (see SourcesSheet.html)
	 * hosting the selection tree plus a summary column. It is always mounted by
	 * the chat screen (only its dialog content comes and goes) so it can load
	 * the tree once and keep reporting counts to the SourceTrigger chip and to
	 * Chat's ScopeIndicator even while closed.
	 *
	 * `includedPaths` is owned by the chat screen; undefined means "all"
	 * (Faz 8's contract) and changes flow back out via `onSelectionChange`.
	 */
	let {
		open = $bindable(false),
		vaultId,
		vaultName,
		includedPaths,
		onSelectionChange,
		onCounts
	}: {
		open?: boolean;
		vaultId: string;
		vaultName: string;
		includedPaths?: string[];
		onSelectionChange: (paths: string[] | undefined) => void;
		onCounts?: (counts: SourceCounts) => void;
	} = $props();

	let tree = $state<LibraryNode[]>([]);
	// Display-only reshaping (vault-configurable hidden/flattened root
	// folders, see library.ts's DEFAULT_SETTINGS and applyDisplayRules'
	// doc comment) — selection/scoping always operates on the paths of what
	// is DISPLAYED, never the raw tree: paths must stay exactly what
	// retrieve.ts and the generators expect, and hidden files must not be
	// silently pinned into `selected` where the user has no control to
	// toggle them (a real scope once ended up persisted as 205 paths when
	// the user had picked exactly one visible folder). Empty until settings
	// load: an unreachable settings endpoint must not hide selectable content.
	let displayRules = $state<{ hiddenFolders: string[]; flattenFolders: string[] }>({
		hiddenFolders: [],
		flattenFolders: []
	});
	let loadError = $state('');
	let filterQuery = $state('');
	let view = $state<'all' | 'selected'>('all');
	let confirmingNone = $state(false);
	let searchEl: HTMLInputElement | undefined = $state();

	let displayTree = $derived(applyDisplayRules(tree, displayRules));
	let displayFiles = $derived(collectFilePaths(displayTree));
	// A saved scope can name files that were since renamed/removed/hidden;
	// counting those made the summary read "2 of 1 notes (200%)". Only
	// displayed files count — unfiltered until the tree has loaded.
	let selected = $derived.by(() => {
		if (includedPaths === undefined) return new Set(displayFiles);
		if (displayFiles.length === 0) return new Set(includedPaths);
		const shown = new Set(displayFiles);
		return new Set(includedPaths.filter((p) => shown.has(p)));
	});
	let areas = $derived(selectedAreas(displayTree, selected));
	let percent = $derived(
		displayFiles.length === 0 ? 0 : Math.round((selected.size / displayFiles.length) * 100)
	);

	$effect(() => {
		onCounts?.({
			selected: selected.size,
			total: displayFiles.length,
			areasSelected: areas.length,
			areasTotal: displayTree.length
		});
	});

	onMount(async () => {
		try {
			const res = await fetch(`/api/library/tree?vault=${encodeURIComponent(vaultId)}`);
			if (!res.ok) throw new Error();
			tree = ((await res.json()) as { tree: LibraryNode[] }).tree;
		} catch {
			loadError = t('SourceTree.loadError');
		}
		try {
			const res = await fetch(`/api/library/settings?vault=${encodeURIComponent(vaultId)}`);
			if (res.ok) {
				const settings = (await res.json()) as LibrarySettings;
				displayRules = { hiddenFolders: settings.hiddenFolders, flattenFolders: settings.flattenFolders };
			}
		} catch {
			// displayRules just stays at its fail-open default (show everything)
		}
	});

	function commit(next: ReadonlySet<string>) {
		onSelectionChange(toIncludedPaths(next, displayFiles));
	}

	function handleToggle(node: LibraryNode) {
		commit(toggleNode(node, selected));
	}

	function handleOnly(node: LibraryNode) {
		commit(selectOnly(node));
	}

	function removeArea(node: LibraryNode) {
		const next = new Set(selected);
		for (const p of selectOnly(node)) next.delete(p);
		commit(next);
	}

	function selectAll() {
		onSelectionChange(undefined);
	}

	function askSelectNone() {
		// Zeroing all sources is a one-click way to silently break the
		// product's core promise (answers grounded only in retrieved
		// sources), so unlike selectAll it gets a confirm step.
		confirmingNone = true;
	}

	function confirmSelectNone() {
		confirmingNone = false;
		onSelectionChange([]);
	}

	function onContentKeydown(e: KeyboardEvent) {
		if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
		const el = e.target as HTMLElement;
		if (el.closest('input, textarea')) return;
		e.preventDefault();
		searchEl?.focus();
	}

	function nameWithPartial(a: { node: LibraryNode; selected: number; total: number }) {
		return a.selected < a.total ? a.node.name + ' (' + t('SourcesSheet.partial') + ')' : a.node.name;
	}
</script>

<Sheet.Root bind:open>
	<Sheet.Portal>
		<Sheet.Overlay class="bg-[var(--scrim)]" />
		<DialogPrimitive.Content
			class="vc-root vc-sheet static sources-sheet"
			aria-describedby={undefined}
			onkeydown={onContentKeydown}
		>
			<div class="vc-sheet-head">
				<div>
					<DialogPrimitive.Title><h2>{t('SourcesSheet.title')}</h2></DialogPrimitive.Title>
					<p>{t('SourcesSheet.subtitle', { vault: vaultName })}</p>
				</div>
				<span style="flex:1"></span>
				<DialogPrimitive.Close class="vc-icon-btn" aria-label={t('SourcesSheet.close')}>
					<XIcon size={20} strokeWidth={1.75} aria-hidden="true" />
				</DialogPrimitive.Close>
			</div>

			<div class="vc-sheet-tools">
				<label class="vc-search">
					<input
						type="text"
						bind:this={searchEl}
						bind:value={filterQuery}
						placeholder={t('SourceTree.searchPlaceholder')}
						aria-label={t('SourceTree.searchPlaceholder')}
					/>
					<kbd aria-hidden="true">/</kbd>
				</label>
				<button type="button" class="vc-btn secondary" onclick={selectAll}>{t('SourcesSheet.all')}</button>
				<button type="button" class="vc-btn secondary" onclick={askSelectNone}>{t('SourcesSheet.none')}</button>
				<div class="vc-seg" role="tablist" aria-label={t('SourcesSheet.filterLabel')}>
					<button
						type="button"
						role="tab"
						aria-selected={view === 'all'}
						onclick={() => (view = 'all')}>{t('SourcesSheet.filterAll')}</button
					>
					<button
						type="button"
						role="tab"
						aria-selected={view === 'selected'}
						onclick={() => (view = 'selected')}>{t('SourcesSheet.filterSelected')}</button
					>
				</div>
			</div>

			<div class="vc-sheet-body">
				<div class="tree-scroll">
					<SourceTree
						{displayTree}
						{selected}
						ontoggle={handleToggle}
						onOnly={handleOnly}
						{filterQuery}
						selectedOnly={view === 'selected'}
						{loadError}
					/>
				</div>
				<aside class="vc-sheet-summary" aria-live="polite">
					<div class="big">
						{t('SourcesSheet.notesCount', { count: selected.size.toLocaleString() })}
						<div class="detail">
							{t('SourcesSheet.summaryDetail', {
								percent,
								total: displayFiles.length.toLocaleString(),
								selected: areas.length,
								areas: displayTree.length
							})}
						</div>
					</div>
					<div
						class="vc-meter"
						role="progressbar"
						aria-valuemin={0}
						aria-valuemax={100}
						aria-valuenow={percent}
						aria-label={t('SourcesSheet.title')}
					>
						<span style="width:{percent}%"></span>
					</div>
					<div>
						<div class="eyebrow">{t('SourcesSheet.selectedAreas')}</div>
						{#if areas.length === 0}
							<p class="none">{t('SourcesSheet.noSelection')}</p>
						{:else}
							<div class="vc-row" style="gap:6px">
								{#each areas as a (a.node.path)}
									<span class="vc-sel-chip">
										{nameWithPartial(a)}
										<button
											type="button"
											aria-label={t('SourcesSheet.remove', { name: a.node.name })}
											onclick={() => removeArea(a.node)}
										>
											<XIcon size={12} strokeWidth={2} aria-hidden="true" />
										</button>
									</span>
								{/each}
							</div>
						{/if}
					</div>
				</aside>
			</div>

			<div class="vc-sheet-foot">
				<a class="vc-btn ghost manage" href="/settings/library" onclick={() => (open = false)}>
					{t('SourcesSheet.manage')} →
				</a>
				<span class="info">
					{t('SourcesSheet.info', { areas: areas.length, notes: selected.size.toLocaleString() })}
				</span>
				<DialogPrimitive.Close class="vc-btn primary">{t('SourcesSheet.done')}</DialogPrimitive.Close>
			</div>
		</DialogPrimitive.Content>
	</Sheet.Portal>
</Sheet.Root>

<AlertDialog.Root bind:open={confirmingNone}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>{t('SourceTree.clearAllTitle')}</AlertDialog.Title>
			<AlertDialog.Description>
				{t('SourceTree.clearAllDescription')}
			</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>{t('Common.vazgec')}</AlertDialog.Cancel>
			<AlertDialog.Action onclick={confirmSelectNone}>{t('SourceTree.clearAllConfirm')}</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>

<style>
	/* Centered modal instead of the design's in-column absolute sheet: the
	   dialog lives in a portal at the document root. `.static` (from
	   components.css) already zeroes the transform/opacity gating. */
	:global(.vc-sheet.static.sources-sheet) {
		position: fixed;
		z-index: 50;
		inset: auto;
		top: 50%;
		left: 50%;
		translate: -50% -50%;
		width: min(960px, calc(100vw - 32px));
		height: min(640px, calc(100vh - 32px));
	}

	:global(.vc-sheet.static.sources-sheet[data-state='open']) {
		animation: sheet-in var(--duration-base) cubic-bezier(0.2, 0, 0, 1);
	}

	@keyframes sheet-in {
		from {
			opacity: 0;
			scale: 0.96;
			transform: translateY(16px);
		}
	}

	:global(:root[data-motion="reduce"] .vc-sheet.static.sources-sheet[data-state='open']) {
		animation: none;
	}

	.tree-scroll {
		min-height: 0;
		overflow: auto;
	}

	.big {
		font: 400 34px/41px var(--font-serif);
	}

	.detail {
		font: 400 15px/20px var(--font-sans);
		color: var(--label-secondary);
	}

	.eyebrow {
		font: 500 12px/16px var(--font-sans);
		color: var(--label-secondary);
		text-transform: uppercase;
		letter-spacing: 0.4px;
		margin-bottom: 8px;
	}

	.none {
		margin: 0;
		font: 400 14px/20px var(--font-sans);
		color: var(--label-secondary);
	}

	.manage {
		color: var(--accent-text);
		text-decoration: none;
	}

	@media (max-width: 900px) {
		.vc-sheet-foot .info {
			display: none;
		}
	}
</style>
