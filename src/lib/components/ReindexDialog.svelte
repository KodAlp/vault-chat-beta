<script lang="ts">
	import { onDestroy } from 'svelte';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { t } from '$lib/i18n/index.svelte';
	import { localizeError, readResponseError } from '$lib/server-error';
	import { runGenerationStream } from '$lib/generation-stream';
	import type { ReindexEvent } from '$lib/types';

	/**
	 * Aşama 3c — reusable full-reindex dialog: opens, immediately starts
	 * `POST /api/vaults/[id]/reindex` (Aşama 3b), shows progress, and lets
	 * the user cancel via `DELETE` on the same route. Used from three
	 * places: the vaults settings page (a vault card's own "Yeniden
	 * indeksle" action), the embedding settings card (after a config change
	 * that differs from before), and the chat/generation error paths
	 * (EMBEDDING_MISMATCH — see Message.svelte / GenerationStatusToast.svelte).
	 *
	 * Reuses generation-stream.ts's runGenerationStream — the same
	 * fetch+SSE-parse loop the five generation stores use, including its
	 * idle-stall watchdog and AbortController-based cancellation — rather
	 * than a fourth hand-rolled reader loop. Its `sawTerminal` check only
	 * recognizes 'done'/'error' as terminal (the five generation event
	 * unions have no 'cancelled' variant), so a 'cancelled' event here is
	 * tracked locally and takes priority over whatever the wrapper itself
	 * concludes.
	 */
	let {
		vaultId,
		open = $bindable(false),
		onDone
	}: {
		vaultId: string;
		open?: boolean;
		/** Fired once the rebuild completes AND is swapped into place — callers
		 * use this to refresh whatever status (embeddingMismatch, unindexedCount)
		 * they were showing, or to retry an answer that had embeddingIssue set. */
		onDone?: () => void;
	} = $props();

	type Phase = 'running' | 'done' | 'cancelled' | 'error';
	let phase = $state<Phase>('running');
	let total = $state(0);
	let done = $state(0);
	let currentPath = $state('');
	let doneStats = $state<{ files: number; chunks: number; ms: number } | null>(null);
	let errorMessage = $state('');
	let controller: AbortController | null = null;

	let percent = $derived(total > 0 ? Math.round((done / total) * 100) : done > 0 ? 100 : 0);

	async function start() {
		phase = 'running';
		total = 0;
		done = 0;
		currentPath = '';
		doneStats = null;
		errorMessage = '';
		// Tracked separately from `phase` itself: TypeScript's control-flow
		// narrowing pins `phase` to the literal 'running' from the assignment
		// just above and doesn't account for it being reassigned inside the
		// onEvent closure during the awaited call below — checking this plain
		// boolean instead (rather than re-reading `phase` post-await) avoids a
		// bogus "no overlap" comparison error.
		let handledByEvent = false;
		let sawCancelled = false;
		controller = new AbortController();

		const result = await runGenerationStream<ReindexEvent>(
			`/api/vaults/${encodeURIComponent(vaultId)}/reindex`,
			{},
			controller,
			(event) => {
				if (event.type === 'start') {
					total = event.total;
				} else if (event.type === 'progress') {
					done = event.done;
					total = event.total;
					currentPath = event.path;
				} else if (event.type === 'done') {
					doneStats = { files: event.files, chunks: event.chunks, ms: event.ms };
					phase = 'done';
					handledByEvent = true;
					onDone?.();
				} else if (event.type === 'cancelled') {
					sawCancelled = true;
					handledByEvent = true;
					phase = 'cancelled';
				} else if (event.type === 'error') {
					errorMessage = localizeError(event);
					phase = 'error';
					handledByEvent = true;
				}
			}
		);

		if (sawCancelled) {
			phase = 'cancelled';
			return;
		}
		if (handledByEvent) return; // 'done'/'error' already handled inside onEvent above
		if (result.kind === 'cancelled') {
			phase = 'cancelled';
		} else if (result.kind === 'stalled') {
			errorMessage = t('ReindexDialog.stalled');
			phase = 'error';
		} else if (result.kind === 'bad-response') {
			errorMessage = await readResponseError(result.response);
			phase = 'error';
		} else if (result.kind === 'fetch-error') {
			errorMessage = t('ReindexDialog.networkError');
			phase = 'error';
		} else if (result.kind === 'incomplete') {
			errorMessage = t('ReindexDialog.incomplete');
			phase = 'error';
		}
	}

	// Starts automatically the moment the dialog opens — this is a single
	// action (not a form to fill in first), so there is nothing to configure
	// before kicking it off. Re-armed every time it transitions closed->open,
	// same "open re-syncs" pattern as GenerationDialog.svelte's picker reset.
	let wasOpen = false;
	$effect(() => {
		if (open && !wasOpen) start();
		wasOpen = open;
	});

	function cancel() {
		// Server-authoritative cancel (works even if the fetch's own abort
		// signal doesn't propagate cleanly through some intermediary) AND a
		// local abort so the client stops waiting on the stream immediately.
		fetch(`/api/vaults/${encodeURIComponent(vaultId)}/reindex`, { method: 'DELETE' }).catch(() => {
			// Best-effort — the local abort() below still stops this client's
			// own view of the stream regardless of whether the DELETE landed.
		});
		controller?.abort();
	}

	function close() {
		if (phase === 'running') cancel();
		open = false;
	}

	onDestroy(() => {
		if (phase === 'running') cancel();
	});
</script>

<Dialog.Root bind:open onOpenChange={(o) => !o && close()}>
	<Dialog.Content class="sm:max-w-md">
		<Dialog.Header>
			<Dialog.Title>{t('ReindexDialog.title')}</Dialog.Title>
		</Dialog.Header>

		<div aria-live="polite" aria-atomic="true" class="flex flex-col gap-3">
			{#if phase === 'running'}
				<p class="text-sm text-muted-foreground">{t('ReindexDialog.runningDescription')}</p>
				<div
					role="progressbar"
					aria-label={t('ReindexDialog.progressLabel')}
					aria-valuemin={0}
					aria-valuemax={100}
					aria-valuenow={percent}
					class="h-2 w-full overflow-hidden rounded-full bg-muted"
				>
					<div
						class="h-full rounded-full bg-primary transition-[width] duration-200"
						style="width: {percent}%"
					></div>
				</div>
				<p class="truncate text-xs text-muted-foreground">
					{#if total > 0}
						{t('ReindexDialog.progressCount', { done: String(done), total: String(total) })}
						{#if currentPath}
							· {currentPath}
						{/if}
					{:else}
						{t('ReindexDialog.starting')}
					{/if}
				</p>
			{:else if phase === 'done'}
				<p class="text-sm text-foreground">
					{t('ReindexDialog.doneSummary', {
						files: String(doneStats?.files ?? 0),
						chunks: String(doneStats?.chunks ?? 0),
						seconds: String(Math.round((doneStats?.ms ?? 0) / 1000))
					})}
				</p>
			{:else if phase === 'cancelled'}
				<p class="text-sm text-muted-foreground">{t('ReindexDialog.cancelledSummary')}</p>
			{:else if phase === 'error'}
				<p class="text-sm text-destructive" role="alert">{errorMessage}</p>
			{/if}
		</div>

		<Dialog.Footer>
			{#if phase === 'running'}
				<Button variant="outline" onclick={cancel}>{t('Common.iptal')}</Button>
			{:else if phase === 'error'}
				<Button variant="outline" onclick={() => (open = false)}>{t('Common.kapat')}</Button>
				<Button onclick={start}>{t('ReindexDialog.retry')}</Button>
			{:else}
				<Button onclick={() => (open = false)}>{t('Common.kapat')}</Button>
			{/if}
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
