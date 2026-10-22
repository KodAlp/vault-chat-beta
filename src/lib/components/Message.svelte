<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import { renderMarkdown, stabilizeForStreaming } from '$lib/markdown';
	import type { ChatMessage } from '$lib/types';
	import SourceChip from './SourceChip.svelte';
	import ChatBubble from './ChatBubble.svelte';
	import FallbackNotice from './FallbackNotice.svelte';
	import ThinkingPanel from './ThinkingPanel.svelte';
	import { t } from '$lib/i18n/index.svelte';
	import { localizeError } from '$lib/server-error';

	let {
		message,
		vaultId,
		streaming = false,
		onExpandScope,
		onForceSources,
		onTopic,
		onNotRelevant,
		onReindex
	}: {
		message: ChatMessage;
		vaultId: string;
		streaming?: boolean;
		onExpandScope?: () => void;
		/** Shown when no sources were looked up because the message read as small talk. */
		onForceSources?: () => void;
		/** Offered when the sources span several topics: asks the same question again within one of them. */
		onTopic?: (domain: string) => void;
		/** Offered under a sourced answer to a short message: teaches the gate it was small talk. */
		onNotRelevant?: () => void;
		/** Aşama 3c — offered when message.embeddingIssue === 'mismatch': opens
		 * Chat.svelte's ReindexDialog for the current vault. Not offered for
		 * 'unavailable' — reindexing can't fix a provider that's down. */
		onReindex?: () => void;
	} = $props();
	let html = $state('');

	// Stopped before any answer content arrived (e.g. during the thinking phase) —
	// an empty bubble reads as a bug, not "nothing to show here on purpose".
	let isEmptyInterrupted = $derived(
		message.role === 'assistant' && message.interrupted && !message.content
	);

	// No answer text yet. ThinkingChick (ChatBubble) keeps reading through
	// retrieval, first-token latency AND the model's reasoning phase; it only
	// closes its book once real answer content starts streaming. ThinkingPanel
	// may stream reasoning above it meanwhile.
	let isWaitingForFirstToken = $derived(
		message.role === 'assistant' && streaming && !message.content
	);

	// Streaming fires this effect many times per second; renderMarkdown() is async
	// (waits on shiki's one-time highlighter load), so calls can resolve out of
	// order. Only ever apply the result of the most recently *started* call.
	let latestCall = 0;
	$effect(() => {
		// Only in-flight messages get the truncation guard — a completed message
		// always renders its exact final text, never trimmed.
		const content = streaming ? stabilizeForStreaming(message.content) : message.content;
		const callId = ++latestCall;
		renderMarkdown(content)
			.then((rendered) => {
				if (callId === latestCall) html = rendered;
			})
			.catch((err) => {
				if (callId === latestCall) {
					console.error('renderMarkdown failed', err);
					html = content;
				}
			});
	});
</script>

<div class="message {message.role}">
	{#if message.role === 'assistant' && message.notices?.length}
		{#each message.notices as notice, i ((notice.code ?? notice.message) + '#' + i)}
			<FallbackNotice message={localizeError(notice)} />
		{/each}
	{/if}
	{#if message.role === 'assistant' && message.toolCalls?.length}
		<div class="tool-calls">
			{#each message.toolCalls as tc, i (tc.skill + '#' + tc.path + '#' + i)}
				<span class="vc-chip tool-call-chip" class:error={tc.status === 'error'} title={tc.error}>
					<Icon name="file-text" size="sm" />
					<span class="tool-call-path">{tc.path}</span>
					{#if tc.status === 'reading'}
						<Icon name="loader" size="sm" />
						<span class="tool-call-status">{t('Message.toolReading')}</span>
					{:else if tc.status === 'error'}
						<Icon name="close" size="sm" />
						<span class="tool-call-status">{t('Message.toolError')}</span>
					{:else}
						<Icon name="check" size="sm" />
						<span class="tool-call-status">{t('Message.toolDone')}</span>
					{/if}
				</span>
			{/each}
		</div>
	{/if}
	{#if message.role === 'assistant' && message.thinking}
		<ThinkingPanel thinking={message.thinking} {streaming} />
	{/if}
	<!-- "polite" (not "assertive") so a screen reader announces streamed
	     content without interrupting whatever the user is already doing —
	     the 50ms flush loop in Chat.svelte previously updated this region
	     up to 20x/second with no aria-live at all, so assistive tech never
	     announced an answer arriving. -->
	<div class="bubble-wrap" aria-live={streaming ? 'polite' : 'off'} aria-atomic="false">
		<ChatBubble role={message.role} {html} interrupted={isEmptyInterrupted} loading={isWaitingForFirstToken} />
	</div>
	{#if message.role === 'assistant' && !streaming && message.hedges?.length}
		<span class="vc-badge hedge-badge" title={t('Message.hedgeBadgeTitle', { hedges: message.hedges.join(', ') })}>
			<Icon name="warning" size="sm" />
			{t('Message.hedgeBadge', { count: message.hedges.length })}
		</span>
	{/if}
	{#if message.role === 'assistant' && message.sources?.length}
		<div class="citation-row">
			<SourceChip sources={message.sources} {vaultId} />
		</div>
		{#if onNotRelevant && !streaming}
			<div class="vc-banner info extra">
				<Icon name="info" />
				<div class="d">
					{#if message.taughtSmallTalk}
						{t('Message.taught')}
					{:else}
						<button type="button" class="vc-btn ghost" onclick={onNotRelevant}>{t('Message.notRelevant')}</button>
					{/if}
				</div>
			</div>
		{/if}
	{/if}
	{#if message.role === 'assistant' && message.smallTalk && !streaming}
		<div class="vc-banner info extra">
			<Icon name="info" />
			<div class="d">
				{t('Message.smallTalk')}
				{#if onForceSources}
					<button type="button" class="vc-btn ghost" onclick={onForceSources}>{t('Message.forceSources')}</button>
				{/if}
			</div>
		</div>
	{/if}
	{#if message.role === 'assistant' && message.noRelevantSources && !streaming}
		<div class="vc-banner info extra">
			<Icon name="info" />
			<div class="d">{t('Message.noRelevantSources')}</div>
		</div>
	{/if}
	{#if message.role === 'assistant' && message.topicSpread?.length && !streaming && onTopic}
		<div class="vc-banner info extra">
			<Icon name="info" />
			<div class="d">
				{t('Message.topicSpread')}
				<span class="topic-buttons">
					{#each message.topicSpread as topic (topic)}
						<button type="button" class="vc-btn ghost" aria-label={t('Message.topicSpreadAsk', { topic })} onclick={() => onTopic(topic)}>{topic}</button>
					{/each}
				</span>
			</div>
		</div>
	{/if}
	{#if message.role === 'assistant' && message.narrowScope && !streaming}
		<div class="vc-banner warning extra">
			<Icon name="warning" />
			<div class="d">
				{t('Message.narrowScope')}
				{#if onExpandScope}
					<button type="button" class="vc-btn ghost" onclick={onExpandScope}>{t('Message.expandScope')}</button>
				{/if}
			</div>
		</div>
	{/if}
	{#if message.role === 'assistant' && message.nearCtxLimit && !streaming}
		<div class="vc-banner warning extra">
			<Icon name="warning" />
			<div class="d">{t('Message.nearCtxLimit')}</div>
		</div>
	{/if}
	{#if message.role === 'assistant' && message.embeddingIssue && !streaming}
		<div class="vc-banner warning extra">
			<Icon name="warning" />
			<div class="d">
				{message.embeddingIssue === 'mismatch' ? t('Message.embeddingMismatch') : t('Message.embeddingUnavailable')}
				{#if message.embeddingIssue === 'mismatch' && onReindex}
					<button type="button" class="vc-btn ghost" onclick={onReindex}>{t('Message.reindexNow')}</button>
				{/if}
			</div>
		</div>
	{/if}
</div>

<style>
	.message {
		display: flex;
	}

	.message.user {
		justify-content: flex-end;
	}

	.message.assistant {
		justify-content: flex-start;
		flex-direction: column;
	}

	/* The live region wraps the bubble; keep a user bubble right-aligned inside it. */
	.message.user .bubble-wrap {
		display: flex;
		justify-content: flex-end;
		width: 100%;
	}

	/* Task 8 — the citation row fades in (opacity only) when it first
	   appears, marking the moment sources became available for this answer. */
	.citation-row {
		margin-top: var(--space-2);
		animation: citation-fade-in var(--motion-fast) var(--motion-easing);
	}

	@keyframes citation-fade-in {
		from {
			opacity: 0;
		}
		to {
			opacity: 1;
		}
	}

	/* Post-stream extras: compact banners under the answer. Status = icon +
	   words, with the colour only reinforcing it. */
	.extra {
		margin-top: var(--space-2);
		align-items: center;
		width: fit-content;
		max-width: 100%;
		padding: var(--space-2) var(--space-3);
	}

	.extra :global(.vc-icon) {
		flex: none;
	}

	.extra.warning :global(.vc-icon) {
		color: var(--warning);
	}

	.extra.info :global(.vc-icon) {
		color: var(--info);
	}

	.extra .d {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-1) var(--space-2);
		color: var(--label-secondary);
	}

	.topic-buttons {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-1) var(--space-2);
		min-width: 0;
	}

	.extra .vc-btn {
		height: 28px;
		padding: 0 var(--space-2);
		font-size: 13px;
		line-height: 18px;
		color: var(--accent-text);
	}

	.extra .vc-btn:focus-visible,
	.tool-call-chip:focus-visible {
		outline: 2px solid var(--focus-ring);
		outline-offset: 2px;
	}

	.hedge-badge {
		align-self: flex-start;
		margin-top: var(--space-2);
		height: 24px;
		color: var(--warning);
		box-shadow: inset 0 0 0 1px var(--warning);
	}

	.tool-calls {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
		margin-bottom: var(--space-2);
	}

	.tool-call-chip {
		cursor: default;
		/* A folder-skill's supporting-file path can be long (nested
		   directories) — without min-width:0 a flex child keeps its content's
		   natural width and overflows the message column instead of wrapping. */
		min-width: 0;
		height: auto;
		min-height: 28px;
		padding-block: 4px;
		overflow-wrap: anywhere;
	}

	.tool-call-chip :global(.vc-icon) {
		flex: none;
	}

	.tool-call-chip.error {
		color: var(--danger);
		box-shadow: inset 0 0 0 1px var(--danger);
	}

	.tool-call-status {
		font-weight: 600;
	}
</style>
