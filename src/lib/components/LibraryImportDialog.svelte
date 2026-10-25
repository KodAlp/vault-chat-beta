<script lang="ts">
	import { isTauri } from '@tauri-apps/api/core';
	import type { ImportResultItem, LibraryImportEvent } from '#lib/types.js';
	import type { AdapterId, LibraryImportScan, ReadySource } from '#lib/library-import-sources.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import { t } from '#lib/i18n/index.svelte.js';
	import { serverPlatform } from '#lib/serverPlatform.svelte.js';
	import { localizeError, readResponseError } from '#lib/server-error.js';

	/**
	 * The one dialog behind every ready card of the Library import page:
	 * (1) pick a folder, (2) scan -> preview, (3) import with live progress.
	 * Generalizes the old Obsidian-only dialog; which FORMAT is read is the
	 * `adapter` (several cards share one), and a scan that recognizes a
	 * different format than the clicked card offers to switch.
	 *
	 * The scan writes nothing. Import posts only the scanId (+ optional target
	 * folder): the server imports exactly what the scan recorded.
	 */
	let { source, onclose }: { source: ReadySource; onclose: () => void } = $props();

	let open = $state(true);
	$effect(() => {
		if (!open) onclose();
	});

	type Phase = 'folder' | 'scanning' | 'preview' | 'running' | 'done' | 'error';
	let phase = $state<Phase>('folder');
	let folderPath = $state('');
	// svelte-ignore state_referenced_locally -- the dialog is created per card click, `source` never changes for its lifetime
	let adapter = $state<AdapterId>(source.adapter);
	let scan = $state<LibraryImportScan | null>(null);
	let targetPrefix = $state('');
	let items = $state<ImportResultItem[]>([]);
	let errorMessage = $state('');
	let scanError = $state('');

	// Desktop (Tauri) can open a native folder dialog on every OS; in a plain browser only a typed path works.
	let canPick = $derived(isTauri());

	let example = $derived.by(() => {
		const p = serverPlatform();
		const ex = source.examples;
		return p === 'darwin' ? ex.mac : p === 'linux' ? ex.linux : ex.win;
	});

	function adapterLabel(id: AdapterId, flavor?: string): string {
		if (id === 'logseq') return t('LibraryImport.source_logseq');
		if (id === 'joplin-export') return t('LibraryImport.source_joplin');
		return flavor && flavor !== 'plain' ? t(`LibraryImport.flavor_${flavor}`) : t('LibraryImport.source_markdown');
	}

	let sourceName = $derived(t(`LibraryImport.source_${source.id}`));

	async function pickFolder() {
		try {
			const { open: openFolderDialog } = await import('@tauri-apps/plugin-dialog');
			const picked = await openFolderDialog({ directory: true, multiple: false });
			if (typeof picked === 'string') folderPath = picked;
		} catch {
			// dialog dismissed or unavailable: the typed path still works
		}
	}

	async function runScan(withAdapter: AdapterId) {
		if (!folderPath.trim()) return;
		scanError = '';
		phase = 'scanning';
		try {
			const res = await fetch('/api/library/import-source/scan', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ path: folderPath.trim(), adapter: withAdapter })
			});
			if (!res.ok) throw new Error(await readResponseError(res));
			scan = (await res.json()) as LibraryImportScan;
			adapter = scan.adapter;
			phase = 'preview';
		} catch (err) {
			scanError = err instanceof Error ? err.message : t('LibraryImport.scanFailed');
			phase = 'folder';
		}
	}

	// A different, recognized format that outranks what the clicked card asked for.
	let suggestion = $derived.by(() => {
		if (!scan) return null;
		const mine = scan.detected.find((d) => d.adapter === scan!.adapter);
		const better = scan.detected.find(
			(d) => d.match && d.adapter !== scan!.adapter && d.confidence > (mine?.match ? mine.confidence : 0)
		);
		return better ?? null;
	});

	async function runImport() {
		if (!scan?.scanId) return;
		phase = 'running';
		items = [];
		try {
			const res = await fetch('/api/library/import-source/run', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ scanId: scan.scanId, adapter: scan.adapter, targetPrefix: targetPrefix.trim() })
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
					const event = JSON.parse(line.slice(5)) as LibraryImportEvent;
					if (event.type === 'item') {
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
			// The stream closed without a done/error event (server went away): do not spin forever.
			if (phase === 'running') {
				errorMessage = t('LibraryImport.importFailed');
				phase = 'error';
			}
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : t('LibraryImport.importFailed');
			phase = 'error';
		}
	}

	function startOver() {
		scan = null;
		items = [];
		scanError = '';
		errorMessage = '';
		phase = 'folder';
	}

	// $derived, not a plain const: a bare object literal would call t() once at init and freeze at that locale.
	let STATUS_LABELS = $derived<Record<string, string>>({
		converted: t('LibraryImport.statusConverted'),
		skipped: t('LibraryImport.statusSkipped'),
		needs_review: t('LibraryImport.statusNeedsReview'),
		failed: t('LibraryImport.statusFailed')
	});

	let counts = $derived(
		items.reduce(
			(acc, i) => {
				acc[i.status] = (acc[i.status] ?? 0) + 1;
				return acc;
			},
			{} as Record<string, number>
		)
	);

	let skippedTotal = $derived(scan ? Object.values(scan.skippedByReason).reduce((a, b) => a + b, 0) : 0);

	function warningText(w: { code: string; count?: number }): string {
		return t(`LibraryImport.warn_${w.code}`, { count: w.count ?? 0 });
	}

	let prefixShown = $derived(targetPrefix.trim());
</script>

<Dialog.Root
	{open}
	onOpenChange={(next) => {
		if (next) return;
		// An outside click / Escape must not close the dialog while the import is mid-flight.
		if (phase === 'running' || phase === 'scanning') return;
		open = false;
	}}
>
	<Dialog.Content class="sm:max-w-xl">
		<Dialog.Header>
			<Dialog.Title>{t('LibraryImport.dialogTitle', { source: sourceName })}</Dialog.Title>
			<Dialog.Description>{t('LibraryImport.dialogDescription')}</Dialog.Description>
		</Dialog.Header>

		<div class="body">
			{#if phase === 'folder' || phase === 'scanning'}
				<p class="hint">{t(`LibraryImport.source_${source.id}_hint`)}</p>
				<div class="field">
					<label for="li-folder">{t('LibraryImport.folderLabel')}</label>
					<div class="path-row">
						<Input
							id="li-folder"
							type="text"
							bind:value={folderPath}
							dir="ltr"
							class="path-input"
							placeholder={t('LibraryImport.pathExample', { path: example })}
							disabled={phase === 'scanning'}
							onkeydown={(e: KeyboardEvent) => {
								if (e.key === 'Enter') void runScan(adapter);
							}}
						/>
						{#if canPick}
							<Button variant="outline" onclick={pickFolder} disabled={phase === 'scanning'}>
								{t('LibraryImport.pickFolder')}
							</Button>
						{/if}
					</div>
					{#if !canPick}<p class="help">{t('LibraryImport.pathBrowserNote')}</p>{/if}
				</div>
				{#if scanError}<p class="vc-banner danger" role="alert"><span class="dot"></span><span class="d">{scanError}</span></p>{/if}
				<Dialog.Footer>
					<Button variant="outline" onclick={() => (open = false)} disabled={phase === 'scanning'}>{t('Common.iptal')}</Button>
					<Button onclick={() => runScan(adapter)} disabled={!folderPath.trim() || phase === 'scanning'}>
						{#if phase === 'scanning'}
							<span class="spinner" aria-hidden="true"></span>{t('LibraryImport.scanning')}
						{:else}
							{t('LibraryImport.scan')}
						{/if}
					</Button>
				</Dialog.Footer>
			{:else if phase === 'preview' && scan}
				<p class="path-echo" dir="ltr">{folderPath}</p>

				<div class="vc-row">
					<span class="vc-badge accent">{t('LibraryImport.detectedAs', { source: adapterLabel(scan.adapter, scan.flavor) })}</span>
				</div>

				{#if suggestion}
					<div class="vc-banner info" role="status">
						<span class="dot"></span>
						<div class="grow">
							<div class="d">{t('LibraryImport.looksLike', { detected: adapterLabel(suggestion.adapter, suggestion.flavor), source: adapterLabel(scan.adapter, scan.flavor) })}</div>
							<Button size="sm" variant="outline" class="mt-2" onclick={() => suggestion && runScan(suggestion.adapter)}>
								{t('LibraryImport.switchTo', { detected: adapterLabel(suggestion.adapter, suggestion.flavor) })}
							</Button>
						</div>
					</div>
				{:else if !scan.matched && scan.notes > 0}
					<div class="vc-banner warning" role="status">
						<span class="dot"></span>
						<span class="d">{t('LibraryImport.notDetected', { source: adapterLabel(scan.adapter, scan.flavor) })}</span>
					</div>
				{/if}

				<div class="stats">
					<div class="stat"><span class="n">{scan.notes}</span><span class="l">{t('LibraryImport.statNotes')}</span></div>
					<div class="stat"><span class="n">{scan.attachments}</span><span class="l">{t('LibraryImport.statAttachments')}</span></div>
					<div class="stat"><span class="n">{skippedTotal}</span><span class="l">{t('LibraryImport.statSkipped')}</span></div>
				</div>
				{#if scan.attachments > 0}<p class="help">{t('LibraryImport.attachmentsNote')}</p>{/if}

				{#each scan.warnings as w (w.code)}
					<div class="vc-banner warning" role="status">
						<span class="dot"></span>
						<span class="d">{warningText(w)}</span>
					</div>
				{/each}

				{#if scan.notes === 0}
					<p class="vc-banner danger" role="alert"><span class="dot"></span><span class="d">{t('LibraryImport.nothingFound')}</span></p>
				{/if}

				{#if skippedTotal > 0}
					<details class="vc-disclosure">
						<summary>{t('LibraryImport.skippedHeading', { count: skippedTotal })}</summary>
						<div class="body-inner">
							<ul class="reasons">
								{#each Object.entries(scan.skippedByReason) as [reason, n] (reason)}
									<li><span class="vc-badge">{n}</span> {t(`LibraryImport.skip_${reason}`)}</li>
								{/each}
							</ul>
							<ul class="skipped-list" dir="ltr">
								{#each scan.skipped as s (s.rel)}
									<li title={t(`LibraryImport.skip_${s.reason}`)}>{s.rel}</li>
								{/each}
							</ul>
							{#if skippedTotal > scan.skipped.length}
								<p class="help">{t('LibraryImport.skippedMore', { count: skippedTotal - scan.skipped.length })}</p>
							{/if}
						</div>
					</details>
				{/if}

				{#if scan.notes > 0}
					<div class="field">
						<label for="li-prefix">{t('LibraryImport.prefixLabel')}</label>
						<Input id="li-prefix" type="text" bind:value={targetPrefix} placeholder={t('LibraryImport.prefixPlaceholder')} />
						<p class="help">{t('LibraryImport.prefixHint')}</p>
					</div>
					<div>
						<p class="subhead">{t('LibraryImport.samplesHeading')}</p>
						<ul class="samples" dir="ltr">
							{#each scan.sampleTargets as target (target)}
								<li>{prefixShown ? `${prefixShown}/` : ''}{target}</li>
							{/each}
						</ul>
					</div>
				{/if}

				<Dialog.Footer>
					<Button variant="outline" onclick={startOver}>{t('Common.geriDon')}</Button>
					<Button onclick={runImport} disabled={!scan.scanId || scan.notes === 0}>{t('LibraryImport.importButton')}</Button>
				</Dialog.Footer>
			{:else if phase === 'running'}
				<p class="running">
					<span class="spinner" aria-hidden="true"></span>
					{t('LibraryImport.running')}
				</p>
				<div class="vc-progress" role="progressbar" aria-valuemin="0" aria-valuemax={scan?.notes ?? 0} aria-valuenow={items.length}>
					<span style="width: {scan && scan.notes > 0 ? Math.min(100, Math.round((items.length / scan.notes) * 100)) : 0}%"></span>
				</div>
				<p class="help">{t('LibraryImport.progress', { done: items.length, total: scan?.notes ?? 0 })}</p>
				{#if items.length > 0}
					<p class="help current" dir="ltr">{items[items.length - 1].fileName}</p>
				{/if}
			{:else if phase === 'done'}
				<p class="subhead">{t('LibraryImport.doneTitle')}</p>
				<div class="vc-row">
					{#each Object.entries(counts) as [status, n] (status)}
						<span class="vc-badge {status === 'failed' ? '' : 'accent'}">{STATUS_LABELS[status] ?? status}: {n}</span>
					{/each}
				</div>
				{#if (counts.needs_review ?? 0) > 0}<p class="help">{t('LibraryImport.needsReviewHint')}</p>{/if}
				<div class="result-list">
					{#each items.filter((i) => i.status !== 'skipped') as item (item.id)}
						<div class="result-row">
							<span class="vc-badge {item.status === 'failed' ? 'danger-badge' : item.status === 'needs_review' ? 'warn-badge' : ''}">
								{STATUS_LABELS[item.status] ?? item.status}
							</span>
							<span class="name" dir="ltr">{item.fileName}</span>
							{#if item.reason}
								<span class="help">{localizeError({ code: item.code, params: item.params, message: item.reason })}</span>
							{/if}
						</div>
					{/each}
				</div>
				<Dialog.Footer>
					<Button variant="outline" onclick={startOver}>{t('LibraryImport.importAnother')}</Button>
					<Button variant="outline" href="/settings/library">{t('LibraryImport.viewLibrary')}</Button>
					<Button onclick={() => (open = false)}>{t('Common.kapat')}</Button>
				</Dialog.Footer>
			{:else if phase === 'error'}
				<p class="vc-banner danger" role="alert"><span class="dot"></span><span class="d">{errorMessage}</span></p>
				<Dialog.Footer>
					<Button variant="outline" onclick={startOver}>{t('Common.geriDon')}</Button>
					<Button variant="outline" onclick={() => (open = false)}>{t('Common.kapat')}</Button>
				</Dialog.Footer>
			{/if}
		</div>
	</Dialog.Content>
</Dialog.Root>

<style>
	.body {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
		min-width: 0;
	}
	.hint,
	.help {
		margin: 0;
		font: 400 13px/18px var(--font-sans);
		color: var(--label-secondary);
		overflow-wrap: anywhere;
	}
	.field {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.field label {
		font: 500 13px/18px var(--font-sans);
		color: var(--label);
	}
	.path-row {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
	}
	.path-row :global(.path-input) {
		flex: 1 1 14rem;
		min-width: 0;
	}
	.path-echo {
		margin: 0;
		font: 500 13px/18px var(--font-mono, monospace);
		color: var(--label-secondary);
		overflow-wrap: anywhere;
		text-align: start;
	}
	.stats {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: var(--space-2);
	}
	.stat {
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding: var(--space-2) var(--space-3);
		border-radius: var(--radius-md);
		background: var(--bg-grouped);
		box-shadow: inset 0 0 0 1px var(--separator);
		min-width: 0;
	}
	.stat .n {
		font: 600 20px/24px var(--font-sans);
		color: var(--label);
	}
	.stat .l {
		font: 500 12px/16px var(--font-sans);
		color: var(--label-secondary);
		overflow-wrap: anywhere;
	}
	.subhead {
		margin: 0 0 4px;
		font: 600 13px/18px var(--font-sans);
		color: var(--label);
	}
	.samples,
	.skipped-list,
	.reasons {
		margin: 0;
		padding: 0;
		list-style: none;
		font: 400 12px/18px var(--font-mono, monospace);
		color: var(--label-secondary);
		text-align: start;
	}
	.samples li,
	.skipped-list li {
		overflow-wrap: anywhere;
	}
	.skipped-list {
		max-height: 8rem;
		overflow-y: auto;
		margin-top: var(--space-2);
	}
	.reasons {
		font-family: var(--font-sans);
		font-size: 13px;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.body-inner {
		margin-top: var(--space-2);
		padding-inline-start: var(--space-3);
		border-inline-start: 1px solid var(--separator-strong);
	}
	.grow {
		min-width: 0;
		flex: 1;
	}
	.running {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		margin: 0;
		font: 400 15px/20px var(--font-sans);
	}
	.current {
		font-family: var(--font-mono, monospace);
	}
	.spinner {
		display: inline-block;
		width: 14px;
		height: 14px;
		margin-inline-end: 6px;
		border-radius: 50%;
		border: 2px solid var(--separator-strong);
		border-top-color: var(--accent);
		animation: li-spin 0.8s linear infinite;
	}
	@keyframes li-spin {
		to {
			transform: rotate(360deg);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.spinner {
			animation-duration: 2.4s;
		}
	}
	.result-list {
		display: flex;
		flex-direction: column;
		max-height: 40vh;
		overflow-y: auto;
	}
	.result-row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
		padding-block: 4px;
		border-bottom: 1px solid var(--separator);
		font: 400 14px/20px var(--font-sans);
	}
	.result-row .name {
		min-width: 0;
		overflow-wrap: anywhere;
	}
	.danger-badge {
		background: var(--danger-soft);
		color: var(--danger);
		box-shadow: none;
	}
	.warn-badge {
		background: var(--warning-soft);
		color: var(--warning);
		box-shadow: none;
	}
</style>
