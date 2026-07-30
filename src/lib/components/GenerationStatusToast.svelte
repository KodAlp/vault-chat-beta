<script lang="ts">
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
		onDismiss
	}: {
		status: { phase: 'idle' } | { phase: 'generating'; stage: string } | { phase: 'done' } | { phase: 'error'; message: string };
		stageLabels: Record<string, string>;
		doneMessage: string;
		errorPrefix: string;
		stackIndex: number;
		onView: () => void;
		onDismiss: () => void;
	} = $props();

	const bottom = $derived(`${1.25 + stackIndex * 3}rem`);
</script>

{#if status.phase === 'generating'}
	<div
		class="fixed right-5 z-[200] flex items-center gap-2.5 rounded-full border bg-background px-4 py-2.5 text-sm shadow-lg"
		style="bottom: {bottom}"
	>
		<span
			class="inline-block size-3.5 shrink-0 animate-spin rounded-full border-2 border-border border-t-primary"
			aria-hidden="true"
		></span>
		<span>{stageLabels[status.stage] ?? 'İşleniyor...'}</span>
	</div>
{:else if status.phase === 'done'}
	<button
		type="button"
		class="fixed right-5 z-[200] rounded-full border border-primary bg-background px-4 py-2.5 text-sm font-semibold text-primary shadow-lg"
		style="bottom: {bottom}"
		onclick={onView}
	>
		✓ {doneMessage}
	</button>
{:else if status.phase === 'error'}
	<div
		class="fixed right-5 z-[200] flex max-w-[min(360px,80vw)] items-center gap-2.5 rounded-full border border-destructive bg-background px-4 py-2.5 text-sm text-destructive shadow-lg"
		style="bottom: {bottom}"
	>
		<span>{errorPrefix}{status.message}</span>
		<button type="button" class="shrink-0 border-none bg-transparent p-0 text-inherit" onclick={onDismiss} title="Kapat">
			✕
		</button>
	</div>
{/if}
