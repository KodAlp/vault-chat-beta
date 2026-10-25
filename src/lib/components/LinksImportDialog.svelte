<script lang="ts">
	import type { ImportEvent, ImportResultItem } from '$lib/types';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Badge } from '$lib/components/ui/badge';
	import * as Dialog from '$lib/components/ui/dialog';
	import { t } from '$lib/i18n/index.svelte';
	import { localizeError, readResponseError } from '$lib/server-error';

	// Optional, unlike SingleFileImport's — this dialog lives on the library
	// settings page next to LibraryTree, which refreshes itself on its own
	// mount/onchange wiring; a caller with a tighter refresh loop can still
	// pass one in.
	let { onImported = () => {} }: { onImported?: () => void } = $props();

	let open = $state(false);
	let linksText = $state('');
	let domain = $state('genel');

	// "list this page's PDF links, then let the user choose"
	// (D2 — no automatic crawling). A small inline sub-panel, not a second
	// dialog, so the found links can be appended straight into linksText
	// above without leaving this dialog.
	let scanOpen = $state(false);
	let scanUrl = $state('');
	type ScanPhase = 'idle' | 'running' | 'done' | 'error';
	let scanPhase = $state<ScanPhase>('idle');
	let scanError = $state('');
	let scanResults = $state<{ url: string; text: string }[]>([]);
	let scanSelected = $state<Set<string>>(new Set());
	// A rights checkbox that gates the start button — the app
	// fetches whatever URL the user gives it, so this is the point where
	// they're actually asked to confirm they're allowed to.
	let rightsConfirmed = $state(false);
	type Phase = 'idle' | 'running' | 'done' | 'error';
	let phase = $state<Phase>('idle');
	let items = $state<ImportResultItem[]>([]);
	let errorMessage = $state('');
	let statusLabel = $state('');

	// Each 'pending' item (staged, not yet in the library) gets its own
	// editable title/domain/level draft, keyed by importId — mirrors
	// SingleFileImport's single-item confirm form, just one per pending link
	// instead of one for the whole dialog. savingIds tracks in-flight
	// confirm/cancel calls so a button can't be double-clicked mid-request.
	let drafts = $state<Record<string, { title: string; domain: string; level: string }>>({});
	let savingIds = $state<Set<string>>(new Set());

	// Links that failed in earlier batches (server-side link manifest) — offered
	// as a one-click refill so a flaky batch doesn't have to be re-pasted.
	let retryable = $state<string[]>([]);

	function mergeIntoLinksText(urls: string[]) {
		const existing = linksText
			.split('\n')
			.map((l) => l.trim())
			.filter(Boolean);
		linksText = [...new Set([...existing, ...urls])].join('\n');
	}

	async function loadRetryable() {
		try {
			const res = await fetch('/api/import/links/retryable');
			if (!res.ok) return;
			const body = await res.json().catch(() => null);
			const links: { url: string }[] = Array.isArray(body?.links) ? body.links : [];
			// Drop the ones already typed into the textarea so the hint only shows
			// when it would add something.
			const typed = new Set(linksText.split('\n').map((l) => l.trim()));
			retryable = links.map((l) => l.url).filter((u) => !typed.has(u));
		} catch {
			// the hint is a convenience; a failed lookup just hides it
		}
	}

	function retryFailedFromRun() {
		const failedUrls = items.filter((i) => i.status === 'failed').map((i) => i.fileName);
		linksText = '';
		mergeIntoLinksText(failedUrls);
		phase = 'idle';
		items = [];
		drafts = {};
		retryable = [];
	}

	function openDialog() {
		open = true;
		retryable = [];
		void loadRetryable();
		phase = 'idle';
		items = [];
		drafts = {};
		savingIds = new Set();
		rightsConfirmed = false;
		errorMessage = '';
		scanOpen = false;
		scanUrl = '';
		scanPhase = 'idle';
		scanError = '';
		scanResults = [];
		scanSelected = new Set();
	}

	async function runScan() {
		if (!scanUrl.trim()) return;
		scanPhase = 'running';
		scanError = '';
		scanResults = [];
		scanSelected = new Set();
		try {
			const res = await fetch('/api/import/links/scan', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ url: scanUrl.trim() })
			});
			if (!res.ok) throw new Error(await readResponseError(res));
			const body = await res.json().catch(() => null);
			scanResults = Array.isArray(body?.links) ? body.links : [];
			scanSelected = new Set(scanResults.map((l: { url: string }) => l.url));
			scanPhase = 'done';
		} catch (err) {
			scanError = err instanceof Error ? err.message : t('LinksImportDialog.scanPageError');
			scanPhase = 'error';
		}
	}

	function toggleScanSelected(url: string) {
		const next = new Set(scanSelected);
		if (next.has(url)) next.delete(url);
		else next.add(url);
		scanSelected = next;
	}

	function addSelectedScanLinks() {
		const chosen = scanResults.filter((l) => scanSelected.has(l.url)).map((l) => l.url);
		if (chosen.length === 0) return;
		mergeIntoLinksText(chosen);
		scanOpen = false;
		scanUrl = '';
		scanPhase = 'idle';
		scanResults = [];
		scanSelected = new Set();
	}

	async function run() {
		if (!rightsConfirmed) return;
		const links = linksText
			.split('\n')
			.map((l) => l.trim())
			.filter(Boolean);
		if (links.length === 0) return;
		phase = 'running';
		statusLabel = t('LinksImportDialog.scanning');
		items = [];

		try {
			const res = await fetch('/api/import/links', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ links, domain: domain.trim() || 'genel' })
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
					const event = JSON.parse(line.slice(5)) as ImportEvent;
					if (event.type === 'progress') {
						statusLabel = event.fileName ? t('LinksImportDialog.processingLink', { fileName: event.fileName }) : t('LinksImportDialog.scanning');
					} else if (event.type === 'item') {
						items = [...items, event.item];
						if (event.item.status === 'pending' && event.item.importId && event.item.proposed) {
							drafts[event.item.importId] = { ...event.item.proposed };
						}
					} else if (event.type === 'done') {
						items = event.summary?.items ?? items;
						phase = 'done';
					} else if (event.type === 'error') {
						errorMessage = localizeError(event);
						phase = 'error';
					}
				}
			}
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : t('LinksImportDialog.importFailed');
			phase = 'error';
		}
	}

	function replaceItem(importId: string, next: ImportResultItem) {
		items = items.map((i) => (i.importId === importId ? next : i));
	}

	async function confirmItem(item: ImportResultItem) {
		const draft = item.importId ? drafts[item.importId] : undefined;
		if (!item.importId || !draft || !draft.title.trim() || !draft.domain.trim()) return;
		savingIds = new Set(savingIds).add(item.importId);
		try {
			const res = await fetch(`/api/library/import/${item.importId}/confirm`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ title: draft.title.trim(), domain: draft.domain.trim(), level: draft.level })
			});
			if (!res.ok) {
				throw new Error(await readResponseError(res));
			}
			const saved = (await res.json()) as { path: string };
			replaceItem(item.importId, { ...item, status: 'converted', path: saved.path });
			onImported();
		} catch (err) {
			replaceItem(item.importId, { ...item, status: 'failed', reason: err instanceof Error ? err.message : t('ImportFlow.saveFailed') });
		} finally {
			const next = new Set(savingIds);
			next.delete(item.importId);
			savingIds = next;
		}
	}

	async function cancelItem(item: ImportResultItem) {
		if (!item.importId) return;
		savingIds = new Set(savingIds).add(item.importId);
		try {
			await fetch(`/api/library/import/${item.importId}/cancel`, { method: 'POST' }).catch(() => {});
			replaceItem(item.importId, { ...item, status: 'skipped' });
		} finally {
			const next = new Set(savingIds);
			next.delete(item.importId);
			savingIds = next;
		}
	}

	// $derived, not a plain const — see +layout.svelte's identical STAGE_LABELS
	// comment: a bare object literal would call t() once at component init and
	// freeze at whatever locale was active then.
	let STATUS_LABELS = $derived<Record<string, string>>({
		converted: t('LinksImportDialog.statusConverted'),
		skipped: t('LinksImportDialog.statusSkipped'),
		needs_review: t('LinksImportDialog.statusNeedsReview'),
		failed: t('LinksImportDialog.statusFailed'),
		pending: t('LinksImportDialog.statusPending')
	});

	const STATUS_BADGE_CLASS: Record<string, string> = {
		converted: 'bg-[var(--accent-soft)] text-[var(--accent-text)]',
		needs_review: 'bg-secondary text-[var(--warning)]',
		failed: 'bg-secondary text-destructive'
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

<Button variant="outline" onclick={openDialog}>{t('LinksImportDialog.trigger')}</Button>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-lg">
		<Dialog.Header>
			<Dialog.Title>{t('LinksImportDialog.dialogTitle')}</Dialog.Title>
			<Dialog.Description>
				{t('LinksImportDialog.dialogDescription')}
			</Dialog.Description>
		</Dialog.Header>

		{#if phase === 'idle'}
			<label class="flex flex-col gap-1.5 text-[13px] leading-[18px] font-medium">
				{t('LinksImportDialog.linksLabel')}
				<textarea
					bind:value={linksText}
					rows={6}
					placeholder={t('LinksImportDialog.linksPlaceholder')}
					class="w-full resize-y rounded-[var(--radius-md)] border border-input bg-secondary px-3 py-2 text-[15px] outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring"
				></textarea>
			</label>

			{#if retryable.length > 0}
				<p class="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
					{t('LinksImportDialog.retryableHint', { count: retryable.length })}
					<Button
						type="button"
						variant="ghost"
						size="sm"
						class="h-auto px-1 py-0 text-xs"
						onclick={() => {
							mergeIntoLinksText(retryable);
							retryable = [];
						}}
					>
						{t('LinksImportDialog.loadRetryable')}
					</Button>
				</p>
			{/if}

			<!-- Scan one page for its own PDF links instead of
			     pasting each one by hand. Inline sub-panel, not a second
			     dialog, so results merge straight into linksText above. -->
			{#if !scanOpen}
				<Button type="button" variant="ghost" size="sm" class="w-fit text-xs" onclick={() => (scanOpen = true)}>
					{t('LinksImportDialog.scanPageButton')}
				</Button>
			{:else}
				<div class="flex flex-col gap-1.5 rounded-md border p-2 text-sm">
					<p class="text-xs text-muted-foreground">{t('LinksImportDialog.scanPageHelp')}</p>
					<div class="flex gap-1.5">
						<Input type="text" bind:value={scanUrl} placeholder={t('LinksImportDialog.scanPageUrlPlaceholder')} class="flex-1" />
						<Button type="button" size="sm" onclick={runScan} disabled={!scanUrl.trim() || scanPhase === 'running'}>
							{scanPhase === 'running' ? t('LinksImportDialog.scanPageRunning') : t('LinksImportDialog.scanPageStart')}
						</Button>
					</div>
					{#if scanPhase === 'error'}
						<p class="text-xs text-destructive">{scanError}</p>
					{:else if scanPhase === 'done'}
						{#if scanResults.length === 0}
							<p class="text-xs text-muted-foreground">{t('LinksImportDialog.scanPageEmpty')}</p>
						{:else}
							<div class="flex max-h-40 flex-col gap-1 overflow-y-auto">
								{#each scanResults as link (link.url)}
									<label class="flex items-start gap-2 text-xs">
										<input type="checkbox" class="mt-0.5" checked={scanSelected.has(link.url)} onchange={() => toggleScanSelected(link.url)} />
										<span class="overflow-hidden text-ellipsis whitespace-nowrap" title={link.url}>{link.text}</span>
									</label>
								{/each}
							</div>
							<div class="flex justify-end gap-1.5">
								<Button type="button" variant="outline" size="sm" onclick={() => (scanOpen = false)}>{t('Common.iptal')}</Button>
								<Button type="button" size="sm" onclick={addSelectedScanLinks} disabled={scanSelected.size === 0}>
									{t('LinksImportDialog.scanPageAddSelected', { count: scanSelected.size })}
								</Button>
							</div>
						{/if}
					{/if}
				</div>
			{/if}

			<label class="flex flex-col gap-1.5 text-[13px] leading-[18px] font-medium">
				{t('LinksImportDialog.domainLabel')}
				<Input type="text" bind:value={domain} placeholder="genel" />
			</label>
			<label class="flex items-start gap-2 text-xs text-muted-foreground">
				<input type="checkbox" bind:checked={rightsConfirmed} class="mt-0.5" />
				{t('LinksImportDialog.rightsConfirm')}
			</label>
			<Dialog.Footer>
				<Button variant="outline" onclick={() => (open = false)}>{t('Common.iptal')}</Button>
				<Button onclick={run} disabled={!linksText.trim() || !rightsConfirmed}>{t('LinksImportDialog.start')}</Button>
			</Dialog.Footer>
		{:else if phase === 'running'}
			<p class="flex items-center gap-2 text-sm">
				<span class="inline-block size-3.5 animate-spin rounded-full border-2 border-border border-t-primary" aria-hidden="true"></span>
				{statusLabel}
			</p>
			<p class="text-xs text-muted-foreground">{t('LinksImportDialog.filesProcessed', { count: items.length })}</p>
		{:else if phase === 'done'}
			<div class="mb-1 flex flex-wrap gap-1.5">
				{#each Object.entries(counts) as [status, n] (status)}
					<Badge variant="outline">{STATUS_LABELS[status] ?? status}: {n}</Badge>
				{/each}
			</div>
			<div class="flex max-h-[50vh] flex-col gap-2 overflow-y-auto">
				<!-- A 'pending' item is staged but not yet in the library —
				     each gets its own editable title/domain form and a
				     kaydet/yoksay pair, same review step file/YouTube upload
				     already has, just one card per link instead of one dialog
				     phase for the whole batch. -->
				{#each items.filter((i) => i.status === 'pending') as item (item.importId)}
					{@const draft = item.importId ? drafts[item.importId] : undefined}
					{@const busy = item.importId ? savingIds.has(item.importId) : false}
					{#if draft}
						<div class="flex flex-col gap-1.5 rounded-md border p-2 text-sm">
							<span class="overflow-hidden text-ellipsis whitespace-nowrap text-xs text-muted-foreground">{item.fileName}</span>
							{#if item.warnings && item.warnings.length > 0}
								<ul class="list-disc space-y-0.5 ps-4 text-xs text-destructive">
									{#each item.warnings as warning (warning)}
										<li>{localizeError({ code: warning, message: warning })}</li>
									{/each}
								</ul>
							{/if}
							<Input type="text" bind:value={draft.title} placeholder={t('ImportFlow.titleLabel')} />
							<Input type="text" bind:value={draft.domain} placeholder={t('ImportFlow.domainPlaceholder')} />
							<div class="flex justify-end gap-1.5">
								<Button variant="outline" size="sm" onclick={() => cancelItem(item)} disabled={busy}>{t('Common.iptal')}</Button>
								<Button size="sm" onclick={() => confirmItem(item)} disabled={busy || !draft.title.trim() || !draft.domain.trim()}>
									{busy ? t('Common.kaydediliyor') : t('Common.kaydet')}
								</Button>
							</div>
						</div>
					{/if}
				{/each}
				{#each items.filter((i) => i.status !== 'skipped' && i.status !== 'pending') as item (item.id)}
					<div class="flex items-center gap-2 border-b py-1 text-sm">
						<span class="shrink-0 rounded-[var(--radius-sm)] px-[7px] py-0 text-[11px] leading-[18px] font-medium {STATUS_BADGE_CLASS[item.status] ?? ''}">
							{STATUS_LABELS[item.status] ?? item.status}
						</span>
						<span class="overflow-hidden text-ellipsis whitespace-nowrap">{item.fileName}</span>
						{#if item.reason}<span class="text-xs text-muted-foreground">{localizeError({ code: item.code, params: item.params, message: item.reason })}</span>{/if}
					</div>
				{/each}
			</div>
			<Dialog.Footer>
				{#if (counts.failed ?? 0) > 0}
					<Button variant="outline" onclick={retryFailedFromRun}>{t('LinksImportDialog.retryFailed')}</Button>
				{/if}
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
