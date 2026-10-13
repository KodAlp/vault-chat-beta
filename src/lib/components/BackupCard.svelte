<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { isTauri } from '@tauri-apps/api/core';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import * as Card from '$lib/components/ui/card';
	import { t } from '$lib/i18n/index.svelte';
	import { localizeError, readResponseError } from '$lib/server-error';
	import { runGenerationStream } from '$lib/generation-stream';
	import type { BackupEvent } from '$lib/types';

	/**
	 * #61 - "Back up data" card. Streams POST /api/settings/backup (src/lib/server/backup.ts does the
	 * copying) through the same fetch+SSE loop as ReindexDialog. On the desktop build a native folder
	 * picker fills the destination; in a browser the typed path is the only way.
	 */
	const uid = $props.id();

	type Phase = 'idle' | 'running' | 'done' | 'cancelled' | 'error';
	let destination = $state('');
	let phase = $state<Phase>('idle');
	let done = $state(0);
	let total = $state(0);
	let currentPath = $state('');
	let errorMessage = $state('');
	let result = $state<Extract<BackupEvent, { type: 'done' }> | null>(null);
	let controller: AbortController | null = null;

	let canPick = $derived(isTauri());
	let percent = $derived(total > 0 ? Math.round((done / total) * 100) : 0);
	let running = $derived(phase === 'running');

	onMount(async () => {
		try {
			const res = await fetch('/api/settings/backup');
			if (res.ok && !destination) destination = ((await res.json()) as { defaultDestination: string }).defaultDestination;
		} catch {
			// the field just stays empty; the user can type a path
		}
	});

	onDestroy(() => controller?.abort());

	async function pick() {
		try {
			const { open: openFolderDialog } = await import('@tauri-apps/plugin-dialog');
			const picked = await openFolderDialog({ directory: true, multiple: false });
			if (typeof picked === 'string') destination = picked;
		} catch {
			// dialog dismissed or unavailable: the typed path still works
		}
	}

	function formatBytes(n: number): string {
		if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
		if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
		return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
	}

	async function start() {
		if (!destination.trim() || running) return;
		phase = 'running';
		done = 0;
		total = 0;
		currentPath = '';
		errorMessage = '';
		result = null;
		let handled = false;
		controller = new AbortController();

		const r = await runGenerationStream<BackupEvent>('/api/settings/backup', { destination: destination.trim() }, controller, (event) => {
			if (event.type === 'start') {
				total = event.total;
			} else if (event.type === 'progress') {
				done = event.done;
				total = event.total;
				currentPath = event.path;
			} else if (event.type === 'done') {
				result = event;
				phase = 'done';
				handled = true;
			} else if (event.type === 'cancelled') {
				phase = 'cancelled';
				handled = true;
			} else if (event.type === 'error') {
				errorMessage = localizeError(event);
				phase = 'error';
				handled = true;
			}
		});
		if (handled) return;
		if (r.kind === 'cancelled') {
			phase = 'cancelled';
		} else if (r.kind === 'bad-response') {
			errorMessage = await readResponseError(r.response);
			phase = 'error';
		} else {
			errorMessage = t('BackupCard.interrupted');
			phase = 'error';
		}
	}

	function cancel() {
		controller?.abort();
	}
</script>

<Card.Root class="mt-6">
	<Card.Header>
		<Card.Title level={2}>{t('BackupCard.title')}</Card.Title>
		<Card.Description>{t('BackupCard.description')}</Card.Description>
	</Card.Header>
	<Card.Content class="flex flex-col gap-4">
		<div class="flex flex-col gap-1.5">
			<Label for="{uid}-backup-dest">{t('BackupCard.destination')}</Label>
			<div class="flex gap-2">
				<Input id="{uid}-backup-dest" type="text" bind:value={destination} disabled={running} class="flex-1" />
				{#if canPick}
					<Button type="button" variant="outline" onclick={pick} disabled={running}>{t('BackupCard.choose')}</Button>
				{/if}
			</div>
			<p class="text-xs text-muted-foreground">{t('BackupCard.excludesNote')}</p>
		</div>

		<div class="flex items-center gap-2">
			<Button type="button" onclick={start} disabled={running || !destination.trim()}>
				{running ? t('BackupCard.running') : t('BackupCard.start')}
			</Button>
			{#if running}
				<Button type="button" variant="outline" onclick={cancel}>{t('Common.vazgec')}</Button>
			{/if}
		</div>

		{#if running}
			<div class="flex flex-col gap-1" aria-live="polite">
				<div class="h-2 w-full overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
					<div class="h-full bg-primary transition-[width]" style="width: {percent}%"></div>
				</div>
				<p class="truncate text-xs text-muted-foreground" title={currentPath}>
					{t('BackupCard.progress', { done, total })}{currentPath ? ` - ${currentPath}` : ''}
				</p>
			</div>
		{:else if phase === 'done' && result}
			<div class="flex flex-col gap-1 text-sm" role="status">
				<p class={result.ok ? 'text-[var(--success)]' : 'text-destructive'}>
					{result.ok ? t('BackupCard.doneOk') : t('BackupCard.doneWithFailures', { count: result.failed.length })}
				</p>
				<p class="break-all font-mono text-xs">{result.folder}</p>
				<p class="text-xs text-muted-foreground">{t('BackupCard.totals', { files: result.files, databases: result.databases, size: formatBytes(result.bytes) })}</p>
				{#if result.failed.length > 0}
					<ul class="mt-1 list-disc ps-5 text-xs text-muted-foreground">
						{#each result.failed as f (f.path)}
							<li class="break-all">{f.path}</li>
						{/each}
					</ul>
				{/if}
			</div>
		{:else if phase === 'cancelled'}
			<p class="text-sm text-muted-foreground" role="status">{t('BackupCard.cancelled')}</p>
		{:else if phase === 'error'}
			<p class="text-sm text-destructive" role="alert">{errorMessage}</p>
		{/if}
	</Card.Content>
</Card.Root>
