<script lang="ts">
	import { motionFly } from '$lib/motion';
	import CheckIcon from '@lucide/svelte/icons/check';
	import XIcon from '@lucide/svelte/icons/x';
	import AlertIcon from '@lucide/svelte/icons/triangle-alert';
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
	class="fixed end-5 z-[200]"
	style="bottom: 1.25rem; --stack: {stackIndex}; transform: translateY(calc(-4.5rem * var(--stack, 0))); transition: transform var(--motion-base) var(--motion-easing);"
>
	<!-- A stable wrapper, not aria-live on each swapped-in phase element: the
	     three phases are separate nodes via {#if}/{:else if}, so a screen
	     reader needs one persistent live region to detect the transition
	     between them — an aria-live attribute placed on a brand-new element at
	     the moment it's inserted is not reliably announced the same way a
	     mutation inside an already-registered region is. -->
	<div aria-live="polite" aria-atomic="true">
		{#if status.phase === 'generating'}
			<div class="vc-toast" transition:motionFly={{ y: 12 }}>
				<div class="toast-body">
					<span class="toast-title">{stageLabels[status.stage] ?? t('GenerationStatusToast.defaultGeneratingLabel')}{status.elapsedMs ? t('GenerationStatusToast.elapsedSuffix', { seconds: Math.round(status.elapsedMs / 1000) }) : ''}</span>
					<div class="vc-progress" aria-hidden="true"><span class="indeterminate"></span></div>
				</div>
				{#if onCancel}
					<button
						type="button"
						class="vc-icon-btn toast-btn"
						onclick={onCancel}
						title={t('GenerationStatusToast.cancel')}
						aria-label={t('GenerationStatusToast.cancel')}
					>
						<XIcon size={16} strokeWidth={1.75} aria-hidden="true" />
					</button>
				{/if}
			</div>
		{:else if status.phase === 'done'}
			<button
				type="button"
				class="vc-toast toast-action"
				onclick={onView}
				transition:motionFly={{ y: 12 }}
			>
				<CheckIcon size={20} strokeWidth={1.75} aria-hidden="true" />
				<span class="toast-title">{doneMessage}</span>
			</button>
		{:else if status.phase === 'error'}
			<div class="vc-toast error" role="alert" transition:motionFly={{ y: 12 }}>
				<AlertIcon size={20} strokeWidth={1.75} aria-hidden="true" />
				<div class="toast-body">
					<span class="toast-title">{errorPrefix}{status.message}</span>
					{#if (status.narrowScope && onExpandScope) || (status.embeddingMismatch && onReindex)}
						<div class="toast-actions">
							{#if status.narrowScope && onExpandScope}
								<button
									type="button"
									class="vc-btn secondary"
									onclick={() => {
										onExpandScope?.();
										onDismiss();
									}}
								>
									{t('GenerationStatusToast.expandScope')}
								</button>
							{/if}
							{#if status.embeddingMismatch && onReindex}
								<button type="button" class="vc-btn secondary" onclick={onReindex}>
									{t('GenerationStatusToast.reindexNow')}
								</button>
							{/if}
						</div>
					{/if}
				</div>
				<button
					type="button"
					class="vc-icon-btn toast-btn"
					onclick={onDismiss}
					title={t('GenerationStatusToast.dismiss')}
					aria-label={t('GenerationStatusToast.dismiss')}
				>
					<XIcon size={16} strokeWidth={1.75} aria-hidden="true" />
				</button>
			</div>
		{/if}
	</div>
</div>

<style>
	.vc-toast {
		width: auto;
		min-width: 260px;
		max-width: min(360px, 90vw);
		color: var(--label);
		font: var(--text-subheadline);
	}

	.vc-toast.error {
		align-items: flex-start;
	}

	.toast-body {
		display: flex;
		flex: 1;
		min-width: 0;
		flex-direction: column;
		gap: var(--space-2);
	}

	.toast-title {
		font: var(--text-subheadline);
		font-weight: 600;
		overflow-wrap: anywhere;
	}

	.toast-actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
	}

	.toast-btn {
		flex: none;
	}

	/* The toast is a button in its 'done' phase: reset UA button chrome. */
	.toast-action {
		appearance: none;
		border: 0;
		cursor: pointer;
		text-align: start;
	}

	.toast-action:hover {
		background: var(--bg-elevated);
		box-shadow: var(--shadow-popover), inset 0 0 0 999px var(--fill-hover);
	}

	.vc-toast:focus-visible,
	.vc-btn:focus-visible,
	.toast-btn:focus-visible {
		outline: 2px solid var(--focus-ring);
		outline-offset: 2px;
	}

	/* No percentage is known (the stage label is the progress), so the bar
	   slides; under reduced motion it holds as a static partial fill. */
	.indeterminate {
		width: 40%;
		animation: toast-slide 1.4s var(--motion-easing) infinite;
	}

	@keyframes toast-slide {
		from {
			transform: translateX(-100%);
		}
		to {
			transform: translateX(250%);
		}
	}

	/* The bar starts at the inline start, so in RTL it travels the other way. */
	@keyframes toast-slide-rtl {
		from {
			transform: translateX(100%);
		}
		to {
			transform: translateX(-250%);
		}
	}

	:global(:root[dir="rtl"]) .indeterminate {
		animation-name: toast-slide-rtl;
	}

	:global(:root[data-motion="reduce"]) .indeterminate {
		animation: none;
	}
</style>
