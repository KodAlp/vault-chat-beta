<script lang="ts">
	import Icon from '#lib/components/Icon.svelte';
	import { tick } from 'svelte';
	import { i18n, setLocale, t } from '#lib/i18n/index.svelte.js';
	import { LOCALES, localeInfo, type Locale } from '#lib/i18n/locales.js';

	/**
	 * Hand-rolled combobox (no shadcn Popover/Command exists under components/ui, and pulling in
	 * bits-ui's Command for one list would add a dependency for ~100 lines). Sixteen languages is
	 * too many for the old segmented control; the search box is what keeps a 16-row list usable.
	 *
	 * The popup is position:fixed with coordinates measured from the trigger, not absolute: the
	 * settings page hosts this inside a .vc-list, whose overflow:hidden (rounded-corner clipping)
	 * would cut an absolutely positioned popup off at the row's edge.
	 */

	const uid = $props.id();
	const listId = `${uid}-list`;
	const optionId = (code: string) => `${uid}-opt-${code}`;

	let open = $state(false);
	let query = $state('');
	let activeIndex = $state(0);
	let trigger = $state<HTMLButtonElement>();
	let searchEl = $state<HTMLInputElement>();
	let listEl = $state<HTMLUListElement>();
	let popup = $state<HTMLDivElement>();
	let pos = $state({ top: 0, left: 0, maxHeight: 0, up: false });

	const POPUP_WIDTH = 288;
	// ~8 rows of 36px plus the search box and padding; the list itself is capped to 8 rows.
	const ROW_PX = 36;

	/** Case- and diacritic-insensitive: "turkce" finds Türkçe, "espanol" finds Español, "ı"/"İ" fold to i. */
	function fold(s: string): string {
		return s
			.toLowerCase()
			.normalize('NFD')
			.replace(/\p{M}/gu, '')
			.replace(/ı/g, 'i');
	}

	let filtered = $derived.by(() => {
		const q = fold(query.trim());
		if (!q) return [...LOCALES];
		return LOCALES.filter((l) => fold(l.nativeName).includes(q) || fold(l.englishName).includes(q) || fold(l.code).includes(q));
	});

	let current = $derived(localeInfo(i18n.locale));
	let loading = $derived(i18n.loading !== null);
	let activeDescendant = $derived(open && filtered[activeIndex] ? optionId(filtered[activeIndex].code) : undefined);

	function place() {
		if (!trigger) return;
		const r = trigger.getBoundingClientRect();
		const rtl = getComputedStyle(trigger).direction === 'rtl';
		const width = Math.min(POPUP_WIDTH, window.innerWidth - 16);
		// Align the popup's inline-end edge with the trigger's, then keep it inside the viewport.
		let left = rtl ? r.left : r.right - width;
		left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
		const below = window.innerHeight - r.bottom - 12;
		const above = r.top - 12;
		const wanted = 8 * ROW_PX + 64;
		const up = below < Math.min(wanted, 240) && above > below;
		const room = up ? above : below;
		pos = { top: up ? r.top - 4 : r.bottom + 4, left, maxHeight: Math.max(160, Math.min(wanted, room)), up };
	}

	async function openPopup() {
		query = '';
		place();
		open = true;
		await tick();
		const i = filtered.findIndex((l) => l.code === i18n.locale);
		activeIndex = i === -1 ? 0 : i;
		searchEl?.focus();
		scrollActiveIntoView();
	}

	function closePopup(returnFocus: boolean) {
		open = false;
		if (returnFocus) trigger?.focus();
	}

	function scrollActiveIntoView() {
		const code = filtered[activeIndex]?.code;
		if (!code || !listEl) return;
		listEl.querySelector<HTMLElement>(`#${CSS.escape(optionId(code))}`)?.scrollIntoView({ block: 'nearest' });
	}

	async function select(code: Locale) {
		closePopup(true);
		if (code === i18n.locale) return;
		await setLocale(code);
	}

	function move(delta: number) {
		const n = filtered.length;
		if (n === 0) return;
		activeIndex = (activeIndex + delta + n) % n;
		void tick().then(scrollActiveIntoView);
	}

	function onSearchKeydown(e: KeyboardEvent) {
		switch (e.key) {
			case 'ArrowDown':
				e.preventDefault();
				move(1);
				break;
			case 'ArrowUp':
				e.preventDefault();
				move(-1);
				break;
			case 'Home':
				e.preventDefault();
				activeIndex = 0;
				void tick().then(scrollActiveIntoView);
				break;
			case 'End':
				e.preventDefault();
				activeIndex = Math.max(0, filtered.length - 1);
				void tick().then(scrollActiveIntoView);
				break;
			case 'Enter': {
				e.preventDefault();
				const opt = filtered[activeIndex];
				if (opt) void select(opt.code);
				break;
			}
			case 'Escape':
				// Stop here: the layout's F11/fullscreen Escape handler must not also fire.
				e.preventDefault();
				e.stopPropagation();
				closePopup(true);
				break;
			case 'Tab':
				closePopup(false);
				break;
		}
	}

	function onTriggerKeydown(e: KeyboardEvent) {
		if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
			e.preventDefault();
			if (!open) void openPopup();
		}
	}

	// Click-outside + viewport changes close the popup (a fixed popup would otherwise detach from its trigger on scroll).
	$effect(() => {
		if (!open) return;
		const onPointerDown = (e: PointerEvent) => {
			const target = e.target as Node;
			if (trigger?.contains(target) || popup?.contains(target)) return;
			closePopup(false);
		};
		const onViewportChange = (e: Event) => {
			// Scrolling the language list itself must not dismiss it.
			if (e.type === 'scroll' && popup?.contains(e.target as Node)) return;
			closePopup(false);
		};
		document.addEventListener('pointerdown', onPointerDown, true);
		window.addEventListener('resize', onViewportChange);
		window.addEventListener('scroll', onViewportChange, true);
		return () => {
			document.removeEventListener('pointerdown', onPointerDown, true);
			window.removeEventListener('resize', onViewportChange);
			window.removeEventListener('scroll', onViewportChange, true);
		};
	});

</script>

<div class="lang-combobox">
	<button
		bind:this={trigger}
		type="button"
		class="vc-btn secondary lang-trigger"
		role="combobox"
		aria-haspopup="listbox"
		aria-expanded={open}
		aria-controls={listId}
		aria-busy={loading}
		aria-label={t('SettingsPage.languageTitle')}
		onclick={() => (open ? closePopup(true) : openPopup())}
		onkeydown={onTriggerKeydown}
	>
		<span class="lang-trigger-label" lang={current.code} dir={current.dir}>{current.nativeName}</span>
		{#if loading}
			<Icon name="loader" size="sm" class="animate-spin" />
		{:else}
			<Icon name="chevrons-up-down" size="sm" />
		{/if}
	</button>

	{#if open}
		<div
			bind:this={popup}
			class="vc-menu lang-popup"
			style:top="{pos.up ? 'auto' : `${pos.top}px`}"
			style:bottom={pos.up ? `${window.innerHeight - pos.top}px` : 'auto'}
			style:left="{pos.left}px"
			style:width="{Math.min(POPUP_WIDTH, window.innerWidth - 16)}px"
			style:max-height="{pos.maxHeight}px"
		>
			<div class="lang-search">
				<Icon name="search" size="sm" />
				<input
					bind:this={searchEl}
					bind:value={query}
					type="text"
					role="combobox"
					aria-expanded="true"
					aria-controls={listId}
					aria-activedescendant={activeDescendant}
					aria-autocomplete="list"
					aria-label={t('LanguageCombobox.searchPlaceholder')}
					placeholder={t('LanguageCombobox.searchPlaceholder')}
					autocomplete="off"
					spellcheck="false"
					oninput={() => (activeIndex = 0)}
					onkeydown={onSearchKeydown}
				/>
			</div>
			<ul bind:this={listEl} id={listId} role="listbox" class="lang-list" style:max-height="{8 * ROW_PX}px" aria-label={t('SettingsPage.languageTitle')}>
				{#each filtered as loc, i (loc.code)}
					<!-- svelte-ignore a11y_click_events_have_key_events -->
					<li
						id={optionId(loc.code)}
						role="option"
						class="vc-menu-item lang-option"
						aria-selected={loc.code === i18n.locale}
						data-highlighted={i === activeIndex ? '' : undefined}
						onclick={() => select(loc.code)}
						onpointermove={() => (activeIndex = i)}
					>
						<span class="lang-native" lang={loc.code} dir={loc.dir}>{loc.nativeName}</span>
						<span class="lang-english" lang="en" dir="ltr">— {loc.englishName}</span>
						{#if loc.code === i18n.locale}
							<Icon name="check" size="sm" class="lang-check" />
						{/if}
					</li>
				{:else}
					<li class="lang-empty" role="presentation">{t('LanguageCombobox.noResults')}</li>
				{/each}
			</ul>
		</div>
	{/if}
</div>

<style>
	.lang-combobox {
		display: inline-flex;
	}
	.lang-trigger {
		gap: var(--space-2);
		min-width: 160px;
		justify-content: space-between;
	}
	.lang-popup {
		position: fixed;
		z-index: 60;
		display: flex;
		flex-direction: column;
		gap: 4px;
		overflow: hidden;
		padding: 5px;
	}
	.lang-search {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		padding: 0 var(--space-3);
		height: 34px;
		border-radius: 8px;
		background: var(--fill-control);
		box-shadow: inset 0 0 0 1px var(--separator);
		color: var(--label-secondary);
	}
	.lang-search:focus-within {
		box-shadow: inset 0 0 0 1px var(--border-control), 0 0 0 2px var(--focus-ring);
	}
	.lang-search input {
		flex: 1;
		min-width: 0;
		border: 0;
		outline: 0;
		background: transparent;
		color: var(--label);
		font: 400 15px/20px var(--font-sans);
	}
	.lang-search input::placeholder {
		color: var(--label-tertiary);
	}
	.lang-list {
		margin: 0;
		padding: 0;
		list-style: none;
		overflow-y: auto;
		overscroll-behavior: contain;
	}
	.lang-option {
		height: 36px;
		gap: var(--space-2);
	}
	.lang-native {
		font-weight: 500;
		white-space: nowrap;
	}
	.lang-english {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		opacity: 0.7;
		font-size: 13px;
	}
	/* margin-inline-start:auto pushes the check to the inline end in both LTR and RTL. */
	.lang-option :global(.lang-check) {
		margin-inline-start: auto;
		flex: none;
	}
	.lang-empty {
		padding: var(--space-3);
		color: var(--label-secondary);
		font: 400 15px/20px var(--font-sans);
		text-align: center;
	}
</style>
