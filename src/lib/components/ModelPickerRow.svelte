<script lang="ts">
	import type { ProviderModelOption } from '$lib/types';
	import { selectionKey } from '$lib/model-selection';
	import { t } from '$lib/i18n/index.svelte';
	import * as AlertDialog from '$lib/components/ui/alert-dialog';
	import BotIcon from '@lucide/svelte/icons/bot';
	import BrainIcon from '@lucide/svelte/icons/brain';
	import RotateCcwIcon from '@lucide/svelte/icons/rotate-ccw';

	/**
	 * The model/provider pill + "Derin düşün" pill row — extracted from
	 * Chat.svelte's header, which vault/[id]/+page.svelte's new-chat
	 * composer had copied verbatim (markup and CSS both) rather than
	 * sharing, per that page's own "Mirrors Chat.svelte's own..." comment.
	 * Two copies of scoped Svelte CSS can't be deduped by extracting a
	 * shared stylesheet (scoping is per-component-template, not per-class
	 * name) — a shared component is what actually collapses both the
	 * markup and the styles into one place.
	 *
	 * Deliberately presentational: `onModelChange` is a callback, not an
	 * event this component reacts to itself, because the two callers do
	 * different things with a model change (Chat.svelte PATCHes the chat
	 * row; the vault page just updates local pre-chat-creation state) —
	 * this component has no opinion on that. `thinkMode` is `bind:`-able
	 * since neither caller needs to intercept that specific change.
	 */
	let {
		idPrefix,
		modelOptions,
		activeProvider,
		activeModel,
		thinkMode = $bindable(),
		reviewMode = $bindable(false),
		onModelChange,
		onReviewModeChange,
		class: className = ''
	}: {
		/** Both callers can be mounted on their own separate route at once
		 * (never simultaneously in this app, but ids should still not
		 * collide) — prefixes every id/name/for pair below. */
		idPrefix: string;
		modelOptions: ProviderModelOption[];
		activeProvider: string;
		activeModel: string;
		thinkMode: boolean;
		/** F6 — this chat's mode toggle ('review' vs the default 'free_chat'), as a boolean pill like thinkMode.
		 * Optional/bindable so a caller that doesn't care (there is none yet, but matches thinkMode's own shape)
		 * can ignore it. */
		reviewMode?: boolean;
		onModelChange: (key: string) => void;
		/** Unlike thinkMode, a review-mode change needs a side effect (Chat.svelte persists it to the chat row) —
		 * called after `reviewMode` already updated. The vault page's pre-chat composer has nothing to persist
		 * yet and can leave this unset. */
		onReviewModeChange?: (value: boolean) => void;
		/** Forwarded onto the root element — e.g. Chat.svelte adds its own
		 * top padding via a :global() rule keyed to a class passed here,
		 * since Svelte's scoped styles can't reach into a child's markup
		 * any other way. */
		class?: string;
	} = $props();

	// İ2 (Aşama 8): the cloud option the user just picked but hasn't
	// consented to yet — set instead of calling onModelChange immediately,
	// so the confirmation dialog below can still cancel back to the
	// current selection. null the rest of the time.
	let pendingModel = $state<ProviderModelOption | null>(null);
	let consentBusy = $state(false);

	function handleModelSelect(e: Event & { currentTarget: HTMLSelectElement }): void {
		const key = e.currentTarget.value;
		const opt = modelOptions.find((m) => selectionKey(m.providerId, m.id) === key);
		if (opt && opt.cloud && !opt.consented) {
			pendingModel = opt;
			// The browser already applied the click to the <select>'s own DOM
			// value; onModelChange hasn't run, so the `value` prop below is
			// still the OLD key and Svelte won't reassert an attribute whose
			// reactive expression didn't change. Reset it by hand so the
			// select visibly stays on the current model while the dialog is
			// up. Confirming below calls onModelChange, which changes the
			// prop and reasserts the select's value anyway.
			e.currentTarget.value = selectionKey(activeProvider, activeModel);
			return;
		}
		onModelChange(key);
	}

	async function confirmPendingModel(): Promise<void> {
		if (!pendingModel) return;
		const opt = pendingModel;
		consentBusy = true;
		try {
			await fetch(`/api/providers/${opt.providerId}/consent`, { method: 'POST' });
			onModelChange(selectionKey(opt.providerId, opt.id));
		} finally {
			consentBusy = false;
			pendingModel = null;
		}
	}
</script>

<div class="compose-controls {className}">
	<label class="model-pill" for="{idPrefix}-model-select">
		<span class="sr-only">{t('ModelPickerRow.modelSrLabel')}</span>
		<BotIcon size={13} aria-hidden="true" />
		<select
			id="{idPrefix}-model-select"
			title={t('ModelPickerRow.modelSelectTitle')}
			value={selectionKey(activeProvider, activeModel)}
			onchange={handleModelSelect}
		>
			{#if !modelOptions.some((m) => m.providerId === activeProvider && m.id === activeModel)}
				<option value={selectionKey(activeProvider, activeModel)}>{activeModel}</option>
			{/if}
			{#each modelOptions as m (m.providerId + '/' + m.id)}
				<option value={selectionKey(m.providerId, m.id)}>{m.providerLabel} · {m.id}</option>
			{/each}
		</select>
	</label>
	<label
		class="think-pill"
		class:active={thinkMode}
		for="{idPrefix}-think-mode"
		title={t('ModelPickerRow.thinkModeTitle')}
	>
		<input
			id="{idPrefix}-think-mode"
			name="{idPrefix}-think-mode"
			type="checkbox"
			bind:checked={thinkMode}
			class="sr-only"
		/>
		<BrainIcon size={13} aria-hidden="true" />
		{t('ModelPickerRow.thinkModeLabel')}
	</label>
	<label
		class="think-pill"
		class:active={reviewMode}
		for="{idPrefix}-review-mode"
		title={t('ModelPickerRow.reviewModeTitle')}
	>
		<input
			id="{idPrefix}-review-mode"
			name="{idPrefix}-review-mode"
			type="checkbox"
			checked={reviewMode}
			onchange={(e) => {
				reviewMode = e.currentTarget.checked;
				onReviewModeChange?.(reviewMode);
			}}
			class="sr-only"
		/>
		<RotateCcwIcon size={13} aria-hidden="true" />
		{t('ModelPickerRow.reviewModeLabel')}
	</label>
</div>

<AlertDialog.Root open={pendingModel !== null} onOpenChange={(open) => !open && (pendingModel = null)}>
	<AlertDialog.Content>
		{#if pendingModel}
			<AlertDialog.Header>
				<AlertDialog.Title>{t('ModelPickerRow.consentTitle')}</AlertDialog.Title>
				<AlertDialog.Description>
					{t('ModelPickerRow.consentDescription', { provider: pendingModel.providerLabel })}
				</AlertDialog.Description>
			</AlertDialog.Header>
			<AlertDialog.Footer>
				<AlertDialog.Cancel>{t('Common.iptal')}</AlertDialog.Cancel>
				<AlertDialog.Action
					disabled={consentBusy}
					onclick={(e) => {
						e.preventDefault();
						confirmPendingModel();
					}}
				>
					{t('ModelPickerRow.consentConfirm')}
				</AlertDialog.Action>
			</AlertDialog.Footer>
		{/if}
	</AlertDialog.Content>
</AlertDialog.Root>

<style>
	.compose-controls {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.model-pill,
	.think-pill {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		background: var(--color-secondary);
		color: var(--color-secondary-foreground);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-pill);
		padding: 0.3rem 0.7rem;
		font-size: 0.75rem;
	}

	.model-pill {
		max-width: 240px;
	}

	.model-pill select {
		appearance: none;
		border: none;
		background: transparent;
		color: inherit;
		font-family: var(--font-sans);
		font-size: 0.75rem;
		max-width: 190px;
		overflow: hidden;
		text-overflow: ellipsis;
		cursor: pointer;
	}

	/* The option list is drawn by the browser, not by this stylesheet: it does
	   NOT inherit .model-pill's background, but Chromium DOES pull `color`
	   down into it. With the select transparent and color:inherit, that meant
	   the pill's light-on-dark text landed on the popup's own light surface —
	   the "white combobox, nothing readable" report. color-scheme in
	   tokens.css makes the UA paint that surface with the right theme; these
	   two declarations stop the text from being inherited onto it regardless
	   of what the UA chooses. Both are needed — neither alone is enough. */
	.model-pill option {
		background-color: var(--color-popover);
		color: var(--color-popover-foreground);
	}
	.model-pill:focus-within {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}

	.model-pill :global(svg) {
		flex-shrink: 0;
		color: var(--color-muted-foreground);
	}

	.think-pill {
		color: var(--color-muted-foreground);
		cursor: pointer;
		user-select: none;
		transition:
			background-color var(--motion-fast) var(--motion-easing),
			color var(--motion-fast) var(--motion-easing),
			border-color var(--motion-fast) var(--motion-easing);
	}

	.think-pill:hover {
		color: var(--color-foreground);
	}

	.think-pill.active {
		background: var(--accent-soft);
		color: var(--accent-text);
		border-color: var(--hairline-accent);
	}

	.think-pill:has(:focus-visible) {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}
</style>
