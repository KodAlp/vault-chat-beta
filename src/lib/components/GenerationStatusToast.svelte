<script lang="ts">
	import { fly } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';
	import CheckIcon from '@lucide/svelte/icons/check';
	import XIcon from '@lucide/svelte/icons/x';

	/**
	 * Shared toast shell for the five generation status widgets — Faz 9
	 * Adım 4. Each of the five *-generation.svelte.ts stores stays separate
	 * (state logic, not UI, see GenerationDialog.svelte's comment); this
	 * component only owns the generic "generating / done / error" toast
	 * chrome. The caller (+layout.svelte, one block per store) supplies the
	 * status object plus the two navigation actions, since only it knows
	 * which store and which /study/* route to go to.
	 */
	let {
		status,
		stageLabels,
		doneMessage,
		errorPrefix,
		stackIndex,
		onView,
		onDismiss,
		onExpandScope
	}: {
		status:
			| { phase: 'idle' }
			| { phase: 'generating'; stage: string; elapsedMs?: number }
			| { phase: 'done' }
			| { phase: 'error'; message: string; narrowScope?: boolean };
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
	} = $props();

	const bottom = $derived(`${1.25 + stackIndex * 3}rem`);
</script>

<!-- A stable wrapper, not aria-live on each swapped-in phase element: the
     three phases are separate nodes via {#if}/{:else if}, so a screen
     reader needs one persistent live region to detect the transition
     between them — an aria-live attribute placed on a brand-new element at
     the moment it's inserted is not reliably announced the same way a
     mutation inside an already-registered region is. -->
<div aria-live="polite" aria-atomic="true">
	{#if status.phase === 'generating'}
		<div
			class="fixed right-5 z-[200] flex items-center gap-2.5 rounded-full border bg-background px-4 py-2.5 text-sm"
			style="bottom: {bottom}; box-shadow: 0 2px 8px var(--accent-glow)"
			transition:fly={{ y: 12, duration: 200, easing: cubicOut }}
		>
			<span
				class="inline-block size-3.5 shrink-0 animate-spin rounded-full border-2 border-border border-t-primary"
				aria-hidden="true"
			></span>
			<span>{stageLabels[status.stage] ?? 'İşleniyor...'}{status.elapsedMs ? ` · ${Math.round(status.elapsedMs / 1000)}sn` : ''}</span>
		</div>
	{:else if status.phase === 'done'}
		<button
			type="button"
			class="fixed right-5 z-[200] flex items-center gap-2 rounded-full border border-primary bg-background px-4 py-2.5 text-sm font-semibold text-primary focus-visible:outline-2 focus-visible:outline-[var(--accent)] focus-visible:outline-offset-2"
			style="bottom: {bottom}; box-shadow: 0 2px 8px var(--accent-glow)"
			onclick={onView}
			transition:fly={{ y: 12, duration: 200, easing: cubicOut }}
		>
			<CheckIcon size={15} aria-hidden="true" /> {doneMessage}
		</button>
	{:else if status.phase === 'error'}
		<div
			class="fixed right-5 z-[200] flex max-w-[min(360px,80vw)] items-center gap-2.5 rounded-full border border-destructive bg-background px-4 py-2.5 text-sm text-destructive"
			style="bottom: {bottom}; box-shadow: 0 2px 8px var(--accent-glow)"
			role="alert"
			transition:fly={{ y: 12, duration: 200, easing: cubicOut }}
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
					Kapsamı genişlet?
				</button>
			{/if}
			<button
				type="button"
				class="flex shrink-0 border-none bg-transparent p-0 text-inherit focus-visible:outline-2 focus-visible:outline-[var(--accent)] focus-visible:outline-offset-2"
				onclick={onDismiss}
				title="Kapat"
				aria-label="Kapat"
			>
				<XIcon size={15} aria-hidden="true" />
			</button>
		</div>
	{/if}
</div>
