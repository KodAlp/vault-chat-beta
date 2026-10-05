<script lang="ts">
	import FileTextIcon from '@lucide/svelte/icons/file-text';
	import { t } from '$lib/i18n/index.svelte';
	import { scopeSummary } from '$lib/source-summary';

	/**
	 * Chip showing the current source scope ("Tüm kasa" / "13 / 14 alan"); a
	 * click opens SourcesSheet. Lives in the chat title bar today. To host it
	 * in the composer instead, Chat can render this same component with the
	 * counts it already receives (selected/total) plus the two area counts
	 * the chat page tracks, and call its existing onFocusTree prop (which the
	 * page wires to "open the sheet") from `onclick`.
	 */
	let {
		selected,
		total,
		areasSelected,
		areasTotal,
		expanded = false,
		onclick
	}: {
		selected: number;
		total: number;
		areasSelected: number;
		areasTotal: number;
		expanded?: boolean;
		onclick: () => void;
	} = $props();

	let zero = $derived(total > 0 && selected === 0);
	let summary = $derived(scopeSummary({ selected, total, areasSelected, areasTotal }));
</script>

<button
	type="button"
	class="source-trigger vc-scope"
	class:zero
	aria-haspopup="dialog"
	aria-expanded={expanded}
	aria-label={t('SourceTrigger.open', { summary })}
	{onclick}
>
	<FileTextIcon size={14} strokeWidth={1.75} aria-hidden="true" />
	{summary}
</button>

<style>
	.source-trigger {
		transition: background-color var(--duration-fast);
	}

	.source-trigger:hover {
		background: var(--fill-pressed);
	}

	.source-trigger:focus-visible {
		outline: 2px solid var(--focus-ring);
		outline-offset: 2px;
	}

	/* Zero selected sources breaks the "grounded answers" promise — keep it
	   visibly distinct from any ordinary partial scope. */
	.source-trigger.zero {
		background: transparent;
		color: var(--warning);
		box-shadow: inset 0 0 0 1px var(--warning);
	}

	:global(:root[data-motion="reduce"]) .source-trigger {
		transition: none;
	}
</style>
