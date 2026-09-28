<script lang="ts">
	import { motionFly } from '$lib/motion';
	import CheckIcon from '@lucide/svelte/icons/check';
	import XIcon from '@lucide/svelte/icons/x';
	import { t } from '$lib/i18n/index.svelte';

	/**
	 * Shared toast shell for the five generation status widgets — Faz 9
	 * Adım 4. Each of the five *-generation.svelte.ts stores stays separate
	 * (state logic, not UI, see GenerationDialog.svelte's comment); this
	 * component only owns the generic "generating / done / error" toast
	 * chrome. The caller (+layout.svelte) renders one of these per *entry*
	 * in a store's `items` array (Faz 13 — no more single-slot 'idle'
	 * variant; an idle generation simply isn't in the array, so every
	 * instance of this component always has something to show), supplying
	 * the status object plus the two navigation actions since only it
	 * knows which store and which /study/* route to go to.
	 */
	let {
		status,
		stageLabels,
		doneMessage,
		errorPrefix,
		stackIndex,
		onView,
		onDismiss,
		onExpandScope,
		onCancel,
		onReindex
	}: {
		status:
			| { phase: 'generating'; stage: string; elapsedMs?: number }
			| { phase: 'done' }
			| { phase: 'error'; message: string; narrowScope?: boolean; embeddingMismatch?: boolean };
		stageLabels: Record<string, string>;
		doneMessage: string;
		errorPrefix: string;
		stackIndex: number;
		onView: () => void;
		onDismiss: () => void;
		/** Fires scope-expand.svelte.ts's global signal — only rendered when
		 * status.narrowScope is true, mirroring Message.svelte's own
		 * "kapsamı genişlet?" CTA for the same underlying distinction. */
		onExpandScope?: () => void;
		/** Aborts the in-flight generation this pill represents (the store's
		 * cancelXGeneration(id)) — only rendered while phase is 'generating'.
		 * Optional so a caller mid-migration can still render this component
		 * without wiring cancellation yet. */
		onCancel?: () => void;
		/** Aşama 3c — only rendered when status.embeddingMismatch is true
		 * (the server's EMBEDDING_MISMATCH, generate-errors.ts's
		 * assertNoEmbeddingIssue): opens +layout.svelte's shared ReindexDialog
		 * for this generation's vault. */
		onReindex?: () => void;
	} = $props();

</script>

<!-- Outer per-toast slot: fixed at the corner, base bottom offset only
     (1.25rem — the innermost stack slot). Which slot THIS toast currently
     sits in is expressed as a transform driven by --stack (its stackIndex),
     not as a per-phase inline `bottom`, so when another toast in the stack
     is dismissed and every remaining one's stackIndex shifts down by one,
     this div transitions smoothly into its new slot instead of jumping —
     the reflow the old per-phase `bottom: {1.25 + stackIndex*3}rem` couldn't
     animate, since it wasn't a single persistent element. -->
<div
	class="fixed right-5 z-[200]"
	style="bottom: 1.25rem; --stack: {stackIndex}; transform: translateY(calc(-3rem * var(--stack, 0))); transition: transform var(--motion-base) var(--motion-easing);"
>
	<!-- A stable wrapper, not aria-live on each swapped-in phase element: the
	     three phases are separate nodes via {#if}/{:else if}, so a screen
	     reader needs one persistent live region to detect the transition
	     between them — an aria-live attribute placed on a brand-new element at
	     the moment it's inserted is not reliably announced the same way a
	     mutation inside an already-registered region is. -->
	<div aria-live="polite" aria-atomic="true">
		{#if status.phase === 'generating'}
			<div
				class="flex items-center gap-2.5 rounded-full border bg-background px-4 py-2.5 text-sm"
				style="box-shadow: 0 2px 8px var(--accent-glow)"
				transition:motionFly={{ y: 12 }}
			>
				<span
					class="inline-block size-3.5 shrink-0 animate-spin rounded-full border-2 border-border border-t-primary"
					aria-hidden="true"
				></span>
				<span>{stageLabels[status.stage] ?? t('GenerationStatusToast.defaultGeneratingLabel')}{status.elapsedMs ? t('GenerationStatusToast.elapsedSuffix', { seconds: Math.round(status.elapsedMs / 1000) }) : ''}</span>
				{#if onCancel}
					<button
						type="button"
						class="flex shrink-0 border-none bg-transparent p-0 text-inherit focus-visible:outline-2 focus-visible:outline-[var(--accent)] focus-visible:outline-offset-2"
						onclick={onCancel}
						title={t('GenerationStatusToast.cancel')}
						aria-label={t('GenerationStatusToast.cancel')}
					>
						<XIcon size={15} aria-hidden="true" />
					</button>
				{/if}
			</div>
		{:else if status.phase === 'done'}
			<button
				type="button"
				class="flex items-center gap-2 rounded-full border border-primary bg-background px-4 py-2.5 text-sm font-semibold text-primary focus-visible:outline-2 focus-visible:outline-[var(--accent)] focus-visible:outline-offset-2"
				style="box-shadow: 0 2px 8px var(--accent-glow)"
				onclick={onView}
				transition:motionFly={{ y: 12 }}
			>
				<CheckIcon size={15} aria-hidden="true" /> {doneMessage}
			</button>
		{:else if status.phase === 'error'}
			<div
				class="flex max-w-[min(360px,80vw)] items-center gap-2.5 rounded-full border border-destructive bg-background px-4 py-2.5 text-sm text-destructive"
				style="box-shadow: 0 2px 8px var(--accent-glow)"
				role="alert"
				transition:motionFly={{ y: 12 }}
			>
				<span>{errorPrefix}{status.message}</span>
				{#if status.narrowScope && onExpandScope}
					<button
						type="button"
						class="shrink-0 whitespace-nowrap border-none bg-transparent p-0 text-inherit underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-[var(--accent)] focus-visible:outline-offset-2"
						onclick={() => {
							onExpandScope?.();
							onDismiss();
						}}
					>
						{t('GenerationStatusToast.expandScope')}
					</button>
				{/if}
				{#if status.embeddingMismatch && onReindex}
					<button
						type="button"
						class="shrink-0 whitespace-nowrap border-none bg-transparent p-0 text-inherit underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-[var(--accent)] focus-visible:outline-offset-2"
						onclick={onReindex}
					>
						{t('GenerationStatusToast.reindexNow')}
					</button>
				{/if}
				<button
					type="button"
					class="flex shrink-0 border-none bg-transparent p-0 text-inherit focus-visible:outline-2 focus-visible:outline-[var(--accent)] focus-visible:outline-offset-2"
					onclick={onDismiss}
					title={t('GenerationStatusToast.dismiss')}
					aria-label={t('GenerationStatusToast.dismiss')}
				>
					<XIcon size={15} aria-hidden="true" />
				</button>
			</div>
		{/if}
	</div>
</div>
