<script lang="ts">
	import { renderMarkdown, stabilizeForStreaming } from '$lib/markdown';
	import type { ChatMessage } from '$lib/types';
	import SourceChip from './SourceChip.svelte';
	import ChatBubble from './ChatBubble.svelte';
	import FallbackNotice from './FallbackNotice.svelte';
	import ThinkingPanel from './ThinkingPanel.svelte';
	import { Button } from '$lib/components/ui/button';
	import { t } from '$lib/i18n/index.svelte';
	import { localizeError } from '$lib/server-error';

	let {
		message,
		vaultId,
		streaming = false,
		onExpandScope,
		onForceSources,
		onNotRelevant
	}: {
		message: ChatMessage;
		vaultId: string;
		streaming?: boolean;
		onExpandScope?: () => void;
		/** Shown when no sources were looked up because the message read as small talk. */
		onForceSources?: () => void;
		/** Offered under a sourced answer to a short message: teaches the gate it was small talk. */
		onNotRelevant?: () => void;
	} = $props();
	let html = $state('');

	// Stopped before any answer content arrived (e.g. during the thinking phase) —
	// an empty bubble reads as a bug, not "nothing to show here on purpose".
	let isEmptyInterrupted = $derived(
		message.role === 'assistant' && message.interrupted && !message.content
	);

	// Nothing has arrived yet at all — not even reasoning text. An empty bubble
	// here previously gave zero feedback between hitting send and the first
	// token (retrieval + first-token latency can be several seconds), which
	// read as the page having frozen. Once `thinking` starts streaming,
	// ThinkingPanel below already shows real activity, so this only covers the
	// gap before either shows up — the two indicators never stack.
	let isWaitingForFirstToken = $derived(
		message.role === 'assistant' && streaming && !message.content && !message.thinking
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
				<span class="tool-call-chip" class:error={tc.status === 'error'} title={tc.error}>
					📄 {tc.path}
					{tc.status === 'reading' ? '…' : tc.status === 'error' ? '✕' : '✓'}
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
	<div aria-live={streaming ? 'polite' : 'off'} aria-atomic="false">
		<ChatBubble role={message.role} {html} interrupted={isEmptyInterrupted} loading={isWaitingForFirstToken} />
	</div>
	{#if message.role === 'assistant' && !streaming && message.hedges?.length}
		<span class="hedge-badge" title={t('Message.hedgeBadgeTitle', { hedges: message.hedges.join(', ') })}
			>{t('Message.hedgeBadge', { count: message.hedges.length })}</span
		>
	{/if}
	{#if message.role === 'assistant' && message.sources?.length}
		<div class="citation-row">
			<SourceChip sources={message.sources} {vaultId} />
		</div>
		{#if onNotRelevant && !streaming}
			<p class="narrow-scope">
				{#if message.taughtSmallTalk}
					{t('Message.taught')}
				{:else}
					<Button variant="link" class="h-auto p-0 text-xs" onclick={onNotRelevant}>{t('Message.notRelevant')}</Button>
				{/if}
			</p>
		{/if}
	{/if}
	{#if message.role === 'assistant' && message.smallTalk && !streaming}
		<p class="narrow-scope">
			{t('Message.smallTalk')}
			{#if onForceSources}
				<Button variant="link" class="h-auto p-0 text-xs" onclick={onForceSources}>{t('Message.forceSources')}</Button>
			{/if}
		</p>
	{/if}
	{#if message.role === 'assistant' && message.narrowScope && !streaming}
		<p class="narrow-scope">
			{t('Message.narrowScope')}
			{#if onExpandScope}
				<Button variant="link" class="h-auto p-0 text-xs" onclick={onExpandScope}>{t('Message.expandScope')}</Button>
			{/if}
		</p>
	{/if}
	{#if message.role === 'assistant' && message.nearCtxLimit && !streaming}
		<p class="narrow-scope">{t('Message.nearCtxLimit')}</p>
	{/if}
</div>

<style>
	.message {
		display: flex;
		margin: 0.75rem 0;
	}

	.message.user {
		justify-content: flex-end;
	}

	.message.assistant {
		justify-content: flex-start;
		flex-direction: column;
	}

	/* Task 8 — the citation row fades in (opacity only) when it first
	   appears, marking the moment sources became available for this answer. */
	.citation-row {
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

	.narrow-scope {
		margin-top: 0.4rem;
		font-size: 0.78rem;
		color: var(--color-muted-foreground);
	}

	.hedge-badge {
		align-self: flex-start;
		margin-top: 0.35rem;
		padding: 0.05rem 0.4rem;
		border-radius: 999px;
		font-size: 0.72rem;
		color: var(--warning);
		background: color-mix(in srgb, var(--warning) 20%, transparent);
	}

	.tool-calls {
		display: flex;
		flex-wrap: wrap;
		gap: 0.35rem;
		margin-bottom: 0.4rem;
	}

	.tool-call-chip {
		border: 1px solid var(--color-border);
		border-radius: 999px;
		padding: 0.15rem 0.6rem;
		font-size: 0.72rem;
		color: var(--color-muted-foreground);
		background: var(--color-muted);
		/* A folder-skill's supporting-file path can be long (nested
		   directories) — without this, a flex child's default min-width:auto
		   keeps it from shrinking below its content's natural width, so it
		   overflowed the message column instead of wrapping. */
		min-width: 0;
		overflow-wrap: anywhere;
	}

	.tool-call-chip.error {
		color: var(--color-destructive);
		border-color: var(--color-destructive);
	}
</style>
