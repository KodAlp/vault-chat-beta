<script lang="ts">
	import type { ObsidianImportEvent, ImportResultItem } from '$lib/types';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Badge } from '$lib/components/ui/badge';
	import * as Dialog from '$lib/components/ui/dialog';
	import { t } from '$lib/i18n/index.svelte';
	import { serverPlatform } from '$lib/serverPlatform.svelte';
	import { localizeError, readResponseError } from '$lib/server-error';

	let open = $state(false);
	let sourcePath = $state('');
	type Phase = 'idle' | 'running' | 'done' | 'error';
	let phase = $state<Phase>('idle');
	let items = $state<ImportResultItem[]>([]);
	let errorMessage = $state('');
	let statusLabel = $state('');

	function openDialog() {
		open = true;
		phase = 'idle';
		items = [];
		errorMessage = '';
	}

	async function run() {
		if (!sourcePath.trim()) return;
		phase = 'running';
		statusLabel = t('ImportObsidianDialog.scanning');
		items = [];

		try {
			const res = await fetch('/api/library/import-obsidian', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ sourcePath: sourcePath.trim() })
			});
			if (!res.ok) throw new Error(await readResponseError(res));
			if (!res.body) throw new Error(t('Common.istekBasarisiz', { status: res.status }));

			const reader = res.body.getReader();
			const decoder = new TextDecoder();
			let buffer = '';
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				const parts = buffer.split('\n\n');
				buffer = parts.pop() ?? '';
				for (const part of parts) {
					const line = part.trim();
					if (!line.startsWith('data:')) continue;
					const event = JSON.parse(line.slice(5)) as ObsidianImportEvent;
					if (event.type === 'progress') {
						statusLabel = event.fileName
							? t('ImportObsidianDialog.processingFile', { fileName: event.fileName })
							: t('ImportObsidianDialog.scanning');
					} else if (event.type === 'item') {
						items = [...items, event.item];
					} else if (event.type === 'done') {
						items = event.summary.items;
						phase = 'done';
					} else if (event.type === 'error') {
						errorMessage = localizeError(event);
						phase = 'error';
					}
				}
			}
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : t('ImportObsidianDialog.importFailed');
			phase = 'error';
		}
	}

	// $derived, not a plain const — see +layout.svelte's identical STAGE_LABELS
	// comment: a bare object literal would call t() once at component init and
	// freeze at whatever locale was active then.
	let STATUS_LABELS = $derived<Record<string, string>>({
		converted: t('ImportObsidianDialog.statusConverted'),
		skipped: t('ImportObsidianDialog.statusSkipped'),
		needs_review: t('ImportObsidianDialog.statusNeedsReview'),
		failed: t('ImportObsidianDialog.statusFailed')
	});

	const STATUS_BADGE_CLASS: Record<string, string> = {
		converted: 'bg-primary/15 text-primary',
		needs_review: 'bg-orange-500/20 text-amber-700 dark:text-amber-400',
		failed: 'bg-destructive/15 text-destructive'
	};

	let counts = $derived(
		items.reduce(
			(acc, i) => {
				acc[i.status] = (acc[i.status] ?? 0) + 1;
				return acc;
			},
			{} as Record<string, number>
		)
	);
</script>

<Button variant="outline" class="border-primary text-primary" onclick={openDialog}>{t('ImportObsidianDialog.trigger')}</Button>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-lg">
		<Dialog.Header>
			<Dialog.Title>{t('ImportObsidianDialog.dialogTitle')}</Dialog.Title>
			<Dialog.Description>
				{t('ImportObsidianDialog.dialogDescription')}
			</Dialog.Description>
		</Dialog.Header>

		{#if phase === 'idle'}
			<label class="flex flex-col gap-1 text-sm">
				{t('ImportObsidianDialog.sourcePathLabel')}
				<Input type="text" bind:value={sourcePath} placeholder={t(
					serverPlatform() === 'darwin'
						? 'ImportObsidianDialog.sourcePathPlaceholderMac'
						: serverPlatform() === 'linux'
							? 'ImportObsidianDialog.sourcePathPlaceholderLinux'
							: 'ImportObsidianDialog.sourcePathPlaceholder'
				)} />
			</label>
			<Dialog.Footer>
				<Button variant="outline" onclick={() => (open = false)}>{t('Common.iptal')}</Button>
				<Button onclick={run} disabled={!sourcePath.trim()}>{t('ImportObsidianDialog.start')}</Button>
			</Dialog.Footer>
		{:else if phase === 'running'}
			<p class="flex items-center gap-2 text-sm">
				<span class="inline-block size-3.5 animate-spin rounded-full border-2 border-border border-t-primary" aria-hidden="true"></span>
				{statusLabel}
			</p>
			<p class="text-xs text-muted-foreground">{t('ImportObsidianDialog.filesProcessed', { count: items.length })}</p>
		{:else if phase === 'done'}
			<div class="mb-1 flex flex-wrap gap-1.5">
				{#each Object.entries(counts) as [status, n] (status)}
					<Badge variant="outline">{STATUS_LABELS[status] ?? status}: {n}</Badge>
				{/each}
			</div>
			<div class="flex max-h-[40vh] flex-col gap-1 overflow-y-auto">
				{#each items.filter((i) => i.status !== 'skipped') as item (item.id)}
					<div class="flex items-center gap-2 border-b py-1 text-sm">
						<span class="shrink-0 rounded-full px-2 py-0.5 text-[0.68rem] {STATUS_BADGE_CLASS[item.status] ?? ''}">
							{STATUS_LABELS[item.status] ?? item.status}
						</span>
						<span class="overflow-hidden text-ellipsis whitespace-nowrap">{item.fileName}</span>
						{#if item.reason}<span class="text-xs text-muted-foreground">{localizeError({ code: item.code, params: item.params, message: item.reason })}</span>{/if}
					</div>
				{/each}
			</div>
			<Dialog.Footer>
				<Button onclick={() => (open = false)}>{t('Common.kapat')}</Button>
			</Dialog.Footer>
		{:else if phase === 'error'}
			<p class="text-sm text-destructive">{errorMessage}</p>
			<Dialog.Footer>
				<Button variant="outline" onclick={() => (open = false)}>{t('Common.kapat')}</Button>
			</Dialog.Footer>
		{/if}
	</Dialog.Content>
</Dialog.Root>
