<script lang="ts">
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { renderMarkdown } from '#lib/markdown.js';
	import { t } from '#lib/i18n/index.svelte.js';

	/**
	 * "Re-read this formula": the stored crop of the original page on top, every LaTeX candidate of
	 * POST /api/library/formula-repair rendered with the app's own KaTeX pipeline below. Choosing one only
	 * reports it through `onuse`; the note page applies it to the editor draft (nothing is saved here).
	 */
	export interface RepairCandidateView {
		latex: string;
		source: string;
		katexOk: boolean | null;
	}

	let {
		open = $bindable(false),
		page,
		cropUrl,
		candidates,
		onuse
	}: {
		open?: boolean;
		page: number;
		cropUrl?: string;
		candidates: RepairCandidateView[];
		onuse: (latex: string) => void;
	} = $props();

	let rendered = $state<string[]>([]);

	// Rendered through the same markdown/KaTeX pipeline as the note itself, so what the user compares
	// with the crop is what the saved note will show.
	$effect(() => {
		const list = candidates;
		let stale = false;
		void Promise.all(list.map((c) => renderMarkdown(`$$\n${c.latex}\n$$`))).then((out) => {
			if (!stale) rendered = out;
		});
		return () => {
			stale = true;
		};
	});

	function sourceLabel(source: string): string {
		switch (source) {
			case 'mineru:adaptive3':
				return t('FormulaRepairDialog.sourceAdaptive');
			case 'mineru:stored':
				return t('FormulaRepairDialog.sourceStored');
			case 'mineru:stock':
				return t('FormulaRepairDialog.sourceStock');
			case 'mineru:tight':
				return t('FormulaRepairDialog.sourceTight');
			case 'previous':
				return t('FormulaRepairDialog.sourcePrevious');
			default:
				return source;
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-xl max-h-[90vh] overflow-y-auto">
		<Dialog.Header>
			<Dialog.Title>{t('FormulaRepairDialog.title', { page })}</Dialog.Title>
			<Dialog.Description>{t('FormulaRepairDialog.description')}</Dialog.Description>
		</Dialog.Header>

		{#if cropUrl}
			<figure class="m-0 rounded-[var(--radius-md)] bg-white p-2 shadow-[inset_0_0_0_1px_var(--separator)]">
				<img src={cropUrl} alt={t('FormulaRepairDialog.cropAlt', { page })} class="mx-auto max-h-48 max-w-full object-contain" />
			</figure>
		{/if}

		{#if candidates.length === 0}
			<p class="text-sm text-muted-foreground" role="status">{t('FormulaRepairDialog.none')}</p>
		{:else}
			<ul class="m-0 flex list-none flex-col gap-2 p-0">
				{#each candidates as cand, i (cand.latex)}
					<li class="flex flex-col gap-1.5 rounded-[var(--radius-md)] p-3 shadow-[inset_0_0_0_1px_var(--separator)]">
						<div class="flex flex-wrap items-center gap-2">
							<span class="text-xs font-medium text-muted-foreground">{sourceLabel(cand.source)}</span>
							{#if cand.katexOk === false}
								<Badge variant="destructive">{t('FormulaRepairDialog.katexFailed')}</Badge>
							{/if}
						</div>
						<div class="markdown-body overflow-x-auto" dir="ltr">{@html rendered[i] ?? ''}</div>
						<div class="flex justify-end">
							<Button size="sm" variant="secondary" onclick={() => onuse(cand.latex)}>{t('FormulaRepairDialog.use')}</Button>
						</div>
					</li>
				{/each}
			</ul>
		{/if}

		<Dialog.Footer>
			<Button variant="outline" onclick={() => (open = false)}>{t('Common.iptal')}</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
