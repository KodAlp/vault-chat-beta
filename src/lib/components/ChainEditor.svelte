<script lang="ts">
	import Icon from '#lib/components/Icon.svelte';
	import { onMount, tick } from 'svelte';
	import { flip } from 'svelte/animate';
	import { flipDuration, motionEase } from '#lib/motion.js';
	import { t } from '#lib/i18n/index.svelte.js';
	import { moveItem } from '#lib/reorder.js';

	/** One fallback-chain row of the providers page: a fixed-height strip of
	 * provider chips (overflow collapses into "+N") and a ⋮ button that opens a
	 * checklist. Checked providers sit on top in chain order and are reordered
	 * by dragging (pointer events — HTML5 drag-and-drop is unreliable in the
	 * Tauri WebView) or with ↑/↓ on a grip handle. */
	let {
		label,
		chain,
		options,
		labelFor: labelOf,
		onchange
	}: {
		label: string;
		chain: string[];
		/** Providers that may be added (enabled ones), in display order. */
		options: { id: string; label: string }[];
		/** Display name for any id in the chain (incl. disabled providers). */
		labelFor?: (id: string) => string;
		onchange: (next: string[]) => void;
	} = $props();

	const uid = $props.id();
	const labelFor = (id: string) => labelOf?.(id) ?? options.find((o) => o.id === id)?.label ?? id;

	// ---------- chip strip: hide what doesn't fit, show "+N" ----------
	let stripEl: HTMLElement | undefined = $state();
	let hiddenCount = $state(0);
	const MORE_RESERVE = 44;

	function measure() {
		if (!stripEl) return;
		const chips = [...stripEl.querySelectorAll<HTMLElement>('[data-chip]')];
		chips.forEach((c) => (c.hidden = false));
		const right = stripEl.getBoundingClientRect().right;
		let hidden = 0;
		chips.forEach((c, i) => {
			const reserve = i === chips.length - 1 ? 0 : MORE_RESERVE;
			if (hidden > 0 || c.getBoundingClientRect().right > right - reserve) {
				c.hidden = true;
				hidden += 1;
			}
		});
		hiddenCount = hidden;
	}

	$effect(() => {
		void chain.length;
		void chain.map(labelFor).join();
		tick().then(measure);
	});

	onMount(() => {
		const ro = new ResizeObserver(() => measure());
		if (stripEl) ro.observe(stripEl);
		return () => ro.disconnect();
	});

	// ---------- popover ----------
	let open = $state(false);
	let triggerEl: HTMLButtonElement | undefined = $state();
	let panelEl: HTMLDivElement | undefined = $state();
	let pos = $state({ top: 0, left: 0, maxHeight: 320, above: false });
	const PANEL_W = 300;

	function place() {
		if (!triggerEl) return;
		const r = triggerEl.getBoundingClientRect();
		const below = window.innerHeight - r.bottom - 12;
		const aboveSpace = r.top - 12;
		const above = below < 220 && aboveSpace > below;
		const maxHeight = Math.max(160, Math.min(360, above ? aboveSpace : below));
		const left = Math.max(8, Math.min(r.right - PANEL_W, window.innerWidth - PANEL_W - 8));
		pos = { top: above ? r.top - 4 : r.bottom + 4, left, maxHeight, above };
	}

	async function toggle() {
		if (open) return close();
		place();
		open = true;
		await tick();
		panelEl?.querySelector<HTMLElement>('button, [tabindex="0"]')?.focus();
	}

	function close(refocus = true) {
		if (!open) return;
		open = false;
		if (refocus) triggerEl?.focus();
	}

	$effect(() => {
		if (!open) return;
		const onDown = (e: PointerEvent) => {
			const target = e.target as Node;
			if (panelEl?.contains(target) || triggerEl?.contains(target)) return;
			close(false);
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				e.preventDefault();
				close();
			}
		};
		const onScroll = (e: Event) => {
			if (panelEl?.contains(e.target as Node)) return;
			place();
		};
		window.addEventListener('pointerdown', onDown, true);
		window.addEventListener('keydown', onKey);
		window.addEventListener('scroll', onScroll, true);
		window.addEventListener('resize', place);
		return () => {
			window.removeEventListener('pointerdown', onDown, true);
			window.removeEventListener('keydown', onKey);
			window.removeEventListener('scroll', onScroll, true);
			window.removeEventListener('resize', place);
		};
	});

	let unselected = $derived(options.filter((o) => !chain.includes(o.id)));

	function add(id: string) {
		onchange([...chain, id]);
	}
	function remove(id: string) {
		onchange(chain.filter((c) => c !== id));
	}

	// ---------- drag to reorder ----------
	let draft = $state<string[] | null>(null);
	let dragId = $state<string | null>(null);
	let ordered = $derived(draft ?? chain);
	let listEl: HTMLOListElement | undefined = $state();
	let scrollEl: HTMLDivElement | undefined = $state();
	let autoScroll = 0;

	function onGripDown(e: PointerEvent, id: string) {
		if (e.button !== 0) return;
		e.preventDefault();
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
		draft = [...chain];
		dragId = id;
	}

	function onGripMove(e: PointerEvent) {
		if (!dragId || !draft || !listEl) return;
		const items = [...listEl.querySelectorAll<HTMLElement>('[data-sel]')];
		const from = draft.indexOf(dragId);
		let to = from;
		items.forEach((el, i) => {
			const r = el.getBoundingClientRect();
			const mid = r.top + r.height / 2;
			if (i < from && e.clientY < mid) to = Math.min(to, i);
			if (i > from && e.clientY > mid) to = Math.max(to, i);
		});
		if (to !== from) draft = moveItem(draft, from, to);
		// Edge auto-scroll for long lists.
		cancelAnimationFrame(autoScroll);
		if (scrollEl) {
			const r = scrollEl.getBoundingClientRect();
			const step = e.clientY < r.top + 28 ? -8 : e.clientY > r.bottom - 28 ? 8 : 0;
			if (step) {
				const run = () => {
					scrollEl?.scrollBy(0, step);
					autoScroll = requestAnimationFrame(run);
				};
				autoScroll = requestAnimationFrame(run);
			}
		}
	}

	function onGripUp() {
		cancelAnimationFrame(autoScroll);
		const next = draft;
		draft = null;
		dragId = null;
		if (next && next.join('\n') !== chain.join('\n')) onchange(next);
	}

	function onGripKey(e: KeyboardEvent, id: string) {
		if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
		e.preventDefault();
		const from = chain.indexOf(id);
		const to = from + (e.key === 'ArrowUp' ? -1 : 1);
		if (to < 0 || to >= chain.length) return;
		onchange(moveItem(chain, from, to));
		tick().then(() =>
			listEl?.querySelector<HTMLElement>(`[data-sel="${CSS.escape(id)}"] .grip`)?.focus()
		);
	}
</script>

<div class="vc-list-row chain-row">
	<span class="chain-task" title={label}>{label}</span>

	<div class="chain-strip" bind:this={stripEl} aria-label={label}>
		{#each chain as id, i (id)}
			<span class="chain-chip" data-chip>
				<span class="chain-n" aria-hidden="true">{i + 1}</span>
				<span class="chain-name">{labelFor(id)}</span>
				<button
					type="button"
					class="chain-x"
					title={t('ProvidersSettingsPage.removeFromChain')}
					aria-label="{t('ProvidersSettingsPage.removeFromChain')}: {labelFor(id)}"
					onclick={() => remove(id)}><Icon name="close" size="sm" /></button
				>
			</span>
		{:else}
			<span class="chain-empty">{t('ProvidersSettingsPage.chainEmpty')}</span>
		{/each}
		{#if hiddenCount > 0}
			<span class="chain-more" title={chain.slice(-hiddenCount).map(labelFor).join(', ')}>+{hiddenCount}</span>
		{/if}
	</div>

	<button
		bind:this={triggerEl}
		type="button"
		class="vc-icon-btn chain-menu"
		aria-haspopup="dialog"
		aria-expanded={open}
		aria-controls="{uid}-panel"
		title={t('ProvidersSettingsPage.chainEdit')}
		aria-label="{t('ProvidersSettingsPage.chainEdit')}: {label}"
		onclick={toggle}
	>
		<Icon name="ellipsis-vertical" />
	</button>
</div>

{#if open}
	<div
		bind:this={panelEl}
		id="{uid}-panel"
		class="vc-menu chain-panel"
		class:above={pos.above}
		role="dialog"
		aria-label="{t('ProvidersSettingsPage.chainEdit')}: {label}"
		style="top:{pos.top}px; left:{pos.left}px; width:{PANEL_W}px; max-height:{pos.maxHeight}px"
	>
		<div class="chain-panel-scroll" bind:this={scrollEl}>
			{#if ordered.length > 0}
				<div class="chain-panel-head">{t('ProvidersSettingsPage.chainOrderHint')}</div>
				<ol class="chain-sel" bind:this={listEl}>
					{#each ordered as id, i (id)}
						<li
							class="chain-opt selected"
							class:dragging={dragId === id}
							data-sel={id}
							animate:flip={{ duration: dragId ? 120 : flipDuration(), easing: motionEase }}
						>
							<button
								type="button"
								class="grip"
								aria-label="{t('ProvidersSettingsPage.chainDragHandle')}: {labelFor(id)}"
								onpointerdown={(e) => onGripDown(e, id)}
								onpointermove={onGripMove}
								onpointerup={onGripUp}
								onpointercancel={onGripUp}
								onkeydown={(e) => onGripKey(e, id)}
							><Icon name="grip-vertical" size="sm" /></button>
							<span class="chain-n" aria-hidden="true">{i + 1}</span>
							<button
								type="button"
								class="opt-toggle"
								role="checkbox"
								aria-checked="true"
								onclick={() => remove(id)}
							>
								<span class="opt-name">{labelFor(id)}</span>
								<span class="opt-box checked" aria-hidden="true"><Icon name="check" size="sm" /></span>
							</button>
						</li>
					{/each}
				</ol>
			{/if}
			{#if unselected.length > 0}
				<div class="chain-panel-head">{t('ProvidersSettingsPage.chainOthers')}</div>
				<ul class="chain-sel">
					{#each unselected as o (o.id)}
						<li class="chain-opt">
							<span class="grip-spacer" aria-hidden="true"></span>
							<button type="button" class="opt-toggle" role="checkbox" aria-checked="false" onclick={() => add(o.id)}>
								<span class="opt-name">{o.label}</span>
								<span class="opt-box" aria-hidden="true"></span>
							</button>
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	</div>
{/if}

<style>
	/* Fixed height whatever the chain length — overflow folds into "+N". */
	.chain-row {
		height: 48px;
		min-height: 48px;
		gap: var(--space-3);
		flex-wrap: nowrap;
	}
	.chain-task {
		flex: 0 0 150px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font: 500 15px/20px var(--font-sans);
		color: var(--label);
	}
	.chain-strip {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: center;
		gap: var(--space-1);
		overflow: hidden;
	}
	.chain-chip {
		flex: none;
		display: inline-flex;
		align-items: center;
		gap: 6px;
		height: 28px;
		padding-block: 0;
		padding-inline: 6px 2px;
		border-radius: var(--radius-md);
		background: var(--fill-control);
		font: 500 13px/18px var(--font-sans);
		color: var(--label);
		white-space: nowrap;
	}
	/* hidden is toggled from measure(), invisible to the compiler. */
	:global(.chain-chip[hidden]) {
		display: none;
	}
	.chain-n {
		flex: none;
		display: inline-grid;
		place-items: center;
		width: 18px;
		height: 18px;
		border-radius: var(--radius-full);
		background: var(--bg-elevated);
		font: 600 11px/1 var(--font-sans);
		color: var(--label-secondary);
		font-variant-numeric: tabular-nums;
	}
	.chain-x {
		display: inline-grid;
		place-items: center;
		width: 22px;
		height: 22px;
		border: 0;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--label-secondary);
		cursor: pointer;
	}
	.chain-x:hover {
		background: var(--fill-hover);
		color: var(--label);
	}
	.chain-more {
		flex: none;
		font: 500 13px/18px var(--font-sans);
		color: var(--label-secondary);
		padding: 0 var(--space-1);
	}
	.chain-empty {
		font: 400 13px/18px var(--font-sans);
		color: var(--label-secondary);
	}
	.chain-menu {
		flex: none;
		margin-inline-start: auto;
	}
	.chain-menu[aria-expanded='true'] {
		background: var(--fill-pressed);
	}
	.chain-x:focus-visible,
	.chain-menu:focus-visible,
	.grip:focus-visible,
	.opt-toggle:focus-visible {
		outline: 2px solid var(--focus-ring);
		outline-offset: 1px;
	}

	/* ---------- panel ---------- */
	.chain-panel {
		position: fixed;
		z-index: 60;
		display: flex;
		flex-direction: column;
		padding: 0;
		overflow: hidden;
	}
	.chain-panel.above {
		translate: 0 -100%;
	}
	.chain-panel-scroll {
		overflow-y: auto;
		padding: var(--space-1);
		overscroll-behavior: contain;
	}
	.chain-panel-head {
		padding: var(--space-2) var(--space-2) var(--space-1);
		font: 500 12px/16px var(--font-sans);
		color: var(--label-secondary);
		text-transform: uppercase;
		letter-spacing: 0.4px;
	}
	.chain-sel {
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.chain-opt {
		display: flex;
		align-items: center;
		gap: 6px;
		height: 36px;
		padding: 0 var(--space-1);
		border-radius: var(--radius-md);
		background: var(--bg-elevated);
	}
	.chain-opt:hover {
		background: var(--fill-hover);
	}
	.chain-opt.dragging {
		position: relative;
		z-index: 1;
		background: var(--fill-pressed);
		box-shadow: var(--shadow-popover);
	}
	.grip,
	.grip-spacer {
		flex: none;
		width: 24px;
		height: 28px;
	}
	.grip {
		display: inline-grid;
		place-items: center;
		border: 0;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--label-tertiary);
		cursor: grab;
		touch-action: none;
	}
	.chain-opt.dragging .grip {
		cursor: grabbing;
	}
	.grip:hover {
		color: var(--label);
	}
	.opt-toggle {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: center;
		gap: var(--space-2);
		height: 100%;
		border: 0;
		background: transparent;
		color: var(--label);
		font: 400 15px/20px var(--font-sans);
		text-align: start;
		cursor: pointer;
	}
	.opt-name {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.opt-box {
		flex: none;
		display: inline-grid;
		place-items: center;
		width: 18px;
		height: 18px;
		border-radius: var(--radius-sm);
		box-shadow: inset 0 0 0 1.5px var(--border-control);
		color: var(--on-accent);
	}
	.opt-box.checked {
		background: var(--accent);
		box-shadow: none;
	}
	:global(:root[data-motion="reduce"]) .chain-opt {
		transition: none;
	}
</style>
