<script lang="ts">
	import { onMount } from 'svelte';
	import type { PendingImportItem } from '#lib/types.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import * as Select from '#lib/components/ui/select/index.js';
	import * as Card from '#lib/components/ui/card/index.js';
	import { t } from '#lib/i18n/index.svelte.js';
	import { localizeError, readResponseError } from '#lib/server-error.js';
	import { pendingImports, refreshPendingImports } from '#lib/pending-imports.svelte.js';
	import { hasActiveImports } from '#lib/pending-imports-view.js';

	/**
	 * Staged imports waiting in the active vault's staging area — MCP agent imports and orphaned browser
	 * uploads alike. Nothing reaches the library until the user confirms here. Hidden when empty; polls
	 * every 3 s only while something is still converting.
	 */
	let { onConfirmed }: { onConfirmed?: () => void } = $props();

	// Per-row edits and busy/error state, keyed by importId so a poll never overwrites what the user typed.
	let edits = $state<Record<string, { title: string; domain: string; level: string }>>({});
	let busy = $state<Record<string, boolean>>({});
	let rowError = $state<Record<string, string>>({});
	let listError = $state('');

	let items = $derived(pendingImports.items);
	let polling = $derived(hasActiveImports(items));

	/** Called only from event handlers (never during render): creates the editable copy on first use. */
	function editFor(item: PendingImportItem) {
		if (!edits[item.importId]) edits[item.importId] = { ...item.proposed };
		return edits[item.importId];
	}

	async function load() {
		listError = (await refreshPendingImports()) ? '' : t('PendingImports.loadFailed');
	}

	onMount(() => {
		void load();
	});

	$effect(() => {
		if (!polling) return;
		const timer = setInterval(() => void load(), 3000);
		return () => clearInterval(timer);
	});

	function stageLabel(item: PendingImportItem): string {
		switch (item.status) {
			case 'queued':
				return t('PendingImports.statusQueued');
			case 'converting':
				return t('PendingImports.statusConverting');
			case 'ready':
				return t('PendingImports.statusReady');
			default:
				return t('PendingImports.statusError');
		}
	}

	function vaultQuery(): string {
		return pendingImports.vaultId ? `?vault=${encodeURIComponent(pendingImports.vaultId)}` : '';
	}

	async function confirm(item: PendingImportItem) {
		const e = editFor(item);
		if (!e.title.trim() || !e.domain.trim() || busy[item.importId]) return;
		busy[item.importId] = true;
		delete rowError[item.importId];
		try {
			const res = await fetch(`/api/library/import/${item.importId}/confirm`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					title: e.title.trim(),
					domain: e.domain.trim(),
					level: e.level,
					vault: pendingImports.vaultId ?? undefined
				})
			});
			if (!res.ok) {
				rowError[item.importId] = await readResponseError(res);
				return;
			}
			delete edits[item.importId];
			await refreshPendingImports();
			onConfirmed?.();
		} catch {
			rowError[item.importId] = t('ImportFlow.saveFailed');
		} finally {
			busy[item.importId] = false;
		}
	}

	async function discard(item: PendingImportItem) {
		if (busy[item.importId]) return;
		busy[item.importId] = true;
		delete rowError[item.importId];
		try {
			const res = await fetch(`/api/library/import/${item.importId}/cancel${vaultQuery()}`, { method: 'POST' });
			if (!res.ok) {
				rowError[item.importId] = await readResponseError(res);
				return;
			}
			delete edits[item.importId];
			await refreshPendingImports();
		} catch {
			rowError[item.importId] = t('PendingImports.removeFailed');
		} finally {
			busy[item.importId] = false;
		}
	}
</script>

{#snippet readyRow(item: PendingImportItem)}
	<!-- The editable copy is created lazily on the first keystroke/confirm; until then the proposed values are shown. -->
	{@const e = edits[item.importId] ?? item.proposed}
	<div class="flex flex-wrap items-center gap-2">
		<Input
			type="text"
			class="h-8 min-w-[10rem] flex-[2]"
			aria-label={t('ImportFlow.titleLabel')}
			value={e.title}
			oninput={(ev) => (editFor(item).title = ev.currentTarget.value)}
		/>
		<Input
			type="text"
			class="h-8 min-w-[7rem] flex-1"
			aria-label={t('ImportFlow.domainLabel')}
			placeholder={t('ImportFlow.domainPlaceholder')}
			value={e.domain}
			oninput={(ev) => (editFor(item).domain = ev.currentTarget.value)}
		/>
		<Select.Root type="single" value={e.level} onValueChange={(v) => (editFor(item).level = v)}>
			<Select.Trigger class="h-8 w-[9.5rem]" aria-label={t('ImportFlow.levelLabel')}>{e.level}</Select.Trigger>
			<Select.Content>
				<Select.Item value="undergraduate" label="undergraduate">undergraduate</Select.Item>
				<Select.Item value="graduate" label="graduate">graduate</Select.Item>
				<Select.Item value="phd" label="phd">phd</Select.Item>
			</Select.Content>
		</Select.Root>
		<div class="flex shrink-0 gap-1.5">
			<Button size="sm" disabled={busy[item.importId] || !e.title.trim() || !e.domain.trim()} onclick={() => confirm(item)}>
				{busy[item.importId] ? t('Common.kaydediliyor') : t('PendingImports.confirm')}
			</Button>
			<Button size="sm" variant="outline" disabled={busy[item.importId]} onclick={() => discard(item)}>
				{t('Common.vazgec')}
			</Button>
		</div>
	</div>
{/snippet}

{#if items.length > 0 || listError}
	<Card.Root class="mb-6">
		<Card.Header>
			<Card.Title level={2}>{t('PendingImports.title')}</Card.Title>
			<Card.Description>{t('PendingImports.description')}</Card.Description>
		</Card.Header>
		<Card.Content class="flex flex-col gap-2">
			{#if listError}
				<p class="text-sm text-destructive" role="alert">{listError}</p>
			{/if}
			{#each items as item (item.importId)}
				<div class="flex flex-col gap-2 rounded-lg border px-3 py-2 text-sm">
					<!-- Fixed-height header line: same height in every status, so a status change never moves the rows below. -->
					<div class="flex h-6 items-center gap-2">
						<span class="min-w-0 flex-1 truncate font-medium" title={item.source.name}>{item.source.name}</span>
						{#if item.by === 'mcp'}
							<Badge variant="secondary" title={t('PendingImports.mcpBadgeTitle')}>MCP</Badge>
						{/if}
						<span class="flex shrink-0 items-center gap-1.5 text-xs {item.status === 'error' ? 'text-destructive' : 'text-muted-foreground'}">
							{#if item.status === 'queued' || item.status === 'converting'}
								<span class="inline-block size-3.5 animate-spin rounded-full border-2 border-border border-t-primary" aria-hidden="true"></span>
							{/if}
							{stageLabel(item)}
						</span>
					</div>

					{#if item.warnings.length > 0}
						<ul class="list-disc space-y-0.5 ps-5 text-xs text-destructive">
							{#each item.warnings as warning (warning)}
								<li>{localizeError({ code: warning, message: warning })}</li>
							{/each}
						</ul>
					{/if}

					<!-- Body line: one control row tall whatever the status. -->
					{#if item.status === 'ready'}
						{@render readyRow(item)}
					{:else if item.status === 'error'}
						<div class="flex min-h-8 items-center justify-between gap-2">
							<p class="min-w-0 text-xs text-destructive" role="alert">
								{localizeError({ code: item.error?.code, params: item.error?.params })}
							</p>
							<Button size="sm" variant="outline" disabled={busy[item.importId]} onclick={() => discard(item)}>
								{t('PendingImports.remove')}
							</Button>
						</div>
					{:else}
						<div class="flex min-h-8 items-center">
							<p class="truncate text-xs text-muted-foreground">{item.proposed.title}</p>
						</div>
					{/if}

					{#if rowError[item.importId]}
						<p class="text-xs text-destructive" role="alert">{rowError[item.importId]}</p>
					{/if}
				</div>
			{/each}
		</Card.Content>
	</Card.Root>
{/if}
