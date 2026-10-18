<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	/**
	 * Formula editor popover (MathLive). Imported only when the user opens a
	 * formula in the WYSIWYG editor, so MathLive (~220 KB gzip) never loads
	 * with the note viewer or with notes that contain no formulas.
	 *
	 * The caller owns the document: this component only reports the LaTeX the
	 * user confirmed. MathLive keeps a formula's original LaTeX byte for byte
	 * until the user edits it, so merely opening and applying is a no-op.
	 */
	import { onMount, tick } from 'svelte';
	import { t, i18n } from '$lib/i18n/index.svelte';
	import { loadMathlive } from '$lib/wysiwyg/mathlive-locale';

	let {
		latex,
		rect,
		onapply,
		oncancel
	}: { latex: string; rect: DOMRect; onapply: (latex: string) => void; oncancel: () => void } = $props();

	let box: HTMLDivElement;
	let slot: HTMLDivElement;
	let field: HTMLElement & { value: string } | undefined;
	let status = $state<'loading' | 'ready' | 'failed'>('loading');
	let top = $state(0);
	let left = $state(0);

	function place() {
		const w = Math.min(520, window.innerWidth - 16);
		const h = box?.offsetHeight ?? 160;
		let x = rect.left;
		let y = rect.bottom + 8;
		if (x + w > window.innerWidth - 8) x = window.innerWidth - 8 - w;
		if (y + h > window.innerHeight - 8) y = Math.max(8, rect.top - h - 8);
		left = Math.max(8, x);
		top = y;
	}

	function apply() {
		onapply(field?.value ?? latex);
	}

	function toggleKeyboard() {
		const kb = (window as unknown as { mathVirtualKeyboard?: { visible: boolean } }).mathVirtualKeyboard;
		if (kb) kb.visible = !kb.visible;
		field?.focus();
	}

	onMount(() => {
		place();
		let disposed = false;
		loadMathlive(i18n.locale)
			.then(async (ml) => {
				if (disposed) return;
				const mf = new ml.MathfieldElement();
				mf.mathVirtualKeyboardPolicy = 'manual';
				mf.value = latex;
				mf.setAttribute('aria-label', t('WysiwygEditor.mathTitle'));
				mf.addEventListener('keydown', (e: KeyboardEvent) => {
					if (e.key === 'Enter' && !e.shiftKey) {
						e.preventDefault();
						e.stopPropagation();
						apply();
					} else if (e.key === 'Escape') {
						e.preventDefault();
						e.stopPropagation();
						oncancel();
					}
				});
				slot.append(mf);
				field = mf as unknown as typeof field;
				status = 'ready';
				await tick();
				place();
				mf.focus();
			})
			.catch(() => {
				status = 'failed';
			});
		const onDocDown = (e: PointerEvent) => {
			const target = e.target as Node;
			// the virtual keyboard lives outside our box; clicking it must not close us
			if (box && !box.contains(target) && !(target as HTMLElement).closest?.('.ML__keyboard, .MLK__backdrop, [class*="ML__"]')) oncancel();
		};
		document.addEventListener('pointerdown', onDocDown, true);
		return () => {
			disposed = true;
			document.removeEventListener('pointerdown', onDocDown, true);
			const kb = (window as unknown as { mathVirtualKeyboard?: { visible: boolean } }).mathVirtualKeyboard;
			if (kb) kb.visible = false;
		};
	});
</script>

<div
	class="math-pop"
	role="dialog"
	aria-label={t('WysiwygEditor.mathTitle')}
	bind:this={box}
	style:top="{top}px"
	style:left="{left}px"
>
	<div class="slot" bind:this={slot}>
		{#if status === 'loading'}<p class="note">{t('WysiwygEditor.mathLoading')}</p>{/if}
		{#if status === 'failed'}<p class="note error">{t('WysiwygEditor.mathLoadFailed')}</p>{/if}
	</div>
	<div class="row">
		<button type="button" class="vc-btn ghost" onclick={toggleKeyboard} disabled={status !== 'ready'}>
			<Icon name="keyboard" size="sm" /> {t('WysiwygEditor.mathKeyboard')}
		</button>
		<span class="spacer"></span>
		<button type="button" class="vc-btn ghost" onclick={oncancel}>{t('WysiwygEditor.cancel')}</button>
		<button type="button" class="vc-btn primary" onclick={apply} disabled={status !== 'ready'}>{t('WysiwygEditor.mathApply')}</button>
	</div>
</div>

<style>
	.math-pop {
		position: fixed;
		z-index: 60;
		width: min(520px, calc(100vw - 16px));
		padding: 0.75rem;
		border-radius: var(--radius-lg);
		background: var(--bg-elevated);
		border: 1px solid var(--separator-strong);
		box-shadow: var(--shadow-lg, 0 12px 32px rgb(0 0 0 / 0.25));
		color: var(--label);
	}

	.slot {
		min-height: 3.2rem;
	}

	.slot :global(math-field) {
		display: block;
		width: 100%;
		font-size: 1.5rem;
		padding: 0.35rem 0.6rem;
		border-radius: var(--radius-md);
		border: 1px solid var(--separator-strong);
		background: var(--bg-grouped, var(--bg-elevated));
		color: var(--label);
		--caret-color: var(--accent);
		--selection-background-color: var(--accent-soft);
		--selection-color: var(--label);
	}

	.slot :global(math-field:focus-within) {
		outline: 2px solid var(--focus-ring);
		outline-offset: 1px;
	}

	.row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin-top: 0.6rem;
	}

	.spacer {
		flex: 1;
	}

	.note {
		margin: 0;
		font: var(--text-footnote);
		color: var(--label-secondary);
	}

	.note.error {
		color: var(--danger);
	}
</style>
