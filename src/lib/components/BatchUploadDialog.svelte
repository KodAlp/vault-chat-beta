<script lang="ts">
	import type { ImportEvent, ImportResultStatus } from '$lib/types';
	import { skipReasonFor, type SkipReason } from '$lib/import-filter';
	import { isTauri } from '@tauri-apps/api/core';
	import { serverPlatform } from '$lib/serverPlatform.svelte';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Badge } from '$lib/components/ui/badge';
	import * as Select from '$lib/components/ui/select';
	import { Switch } from '$lib/components/ui/switch';
	import * as Dialog from '$lib/components/ui/dialog';
	import { t } from '$lib/i18n/index.svelte';
	import { localizeError, readResponseError } from '$lib/server-error';

	let { onImported }: { onImported: () => void } = $props();

	interface QueueEntry {
		// Stable {#each} key: a client-local id until the server answers, then
		// that item's server-assigned id (ImportResultItem.id). A name-based
		// key would collide for two same-named files in one folder pick.
		key: string;
		// Display name and size; the source is EITHER an uploaded File
		// (browsers, macOS/Windows desktop) OR a file inside a folder the
		// server scanned (Linux desktop: scan = { scanId, relPath }).
		name: string;
		size: number;
		file?: File;
		scan?: { scanId: string; relPath: string };
		// '' for a plain multi-file pick; the picked folder's own top-level
		// name and the filename itself already stripped for a folder pick
		// (see buildEntries below) — this is exactly the `relDir` the server
		// expects (relDirToSegments() in batch-paths.ts sanitizes it further).
		relDir: string;
		status: ImportResultStatus;
		// Server failures carry code/params (rendered via localizeError);
		// `reason` is plain text only for client-side skips (already t()'d)
		// and as localizeError's fallback message.
		code?: string;
		params?: Record<string, string | number>;
		reason?: string;
		path?: string;
		// Per-row live state while this file is in flight (several rows can
		// be running at once with parallel processing).
		running?: boolean;
		stage?: string;
		estimatedSeconds?: number;
	}

	let localKeySeq = 0;
	const localKey = () => `local-${++localKeySeq}`;

	function reasonText(entry: QueueEntry): string {
		if (entry.code) return localizeError({ code: entry.code, params: entry.params, message: entry.reason });
		return entry.reason ?? '';
	}

	let open = $state(false);
	type Phase = 'idle' | 'running' | 'done';
	let phase = $state<Phase>('idle');
	let queue = $state<QueueEntry[]>([]);
	let domain = $state('');
	let level = $state('undergraduate');

	// Session-only, not persisted: off = one file at a time (the old behavior).
	let parallel = $state(false);
	let concurrencyChoice = $state('2');

	let stopRequested = false;
	let totalToRun = $state(0);
	let finishedCount = $state(0);

	// $derived, not a plain const — see +layout.svelte's identical STAGE_LABELS
	// comment: a bare object literal would call t() once at component init and
	// freeze at whatever locale was active then. Shares UploadDialog's own
	// stage strings (convert.py emits the same stage names for every caller)
	// rather than duplicating them under a second key.
	let STAGE_LABELS = $derived<Record<string, string>>({
		queued: t('UploadDialog.stageQueued'),
		converting: t('UploadDialog.stageConverting'),
		postprocessing: t('UploadDialog.stagePostprocessing')
	});

	let STATUS_LABELS = $derived<Record<string, string>>({
		converted: t('BatchUploadDialog.statusConverted'),
		skipped: t('BatchUploadDialog.statusSkipped'),
		needs_review: t('BatchUploadDialog.statusNeedsReview'),
		failed: t('BatchUploadDialog.statusFailed'),
		pending: t('BatchUploadDialog.statusPending')
	});

	const STATUS_BADGE_CLASS: Record<string, string> = {
		converted: 'bg-[var(--accent-soft)] text-[var(--accent-text)]',
		needs_review: 'bg-secondary text-[var(--warning)]',
		failed: 'bg-secondary text-destructive'
	};

	let allowedCount = $derived(queue.filter((e) => e.status === 'pending').length);
	let skippedCount = $derived(queue.filter((e) => e.status === 'skipped').length);
	let previewTargets = $derived(
		queue
			.filter((e) => e.status === 'pending')
			.slice(0, 5)
			.map((e) => targetPath(e))
	);
	let counts = $derived(
		queue.reduce(
			(acc, e) => {
				acc[e.status] = (acc[e.status] ?? 0) + 1;
				return acc;
			},
			{} as Record<string, number>
		)
	);

	function targetPath(entry: QueueEntry): string {
		const dirLabel = domain.trim() || '?';
		return entry.relDir ? `${dirLabel}/${entry.relDir}/${entry.name}` : `${dirLabel}/${entry.name}`;
	}

	function skipText(reason: SkipReason, name: string): string {
		if (reason === 'junk') return t('BatchUploadDialog.skipJunk');
		if (reason === 'tooLarge') return t('BatchUploadDialog.skipTooLarge');
		if (reason === 'tooDeep') return t('BatchUploadDialog.skipTooDeep');
		const i = name.lastIndexOf('.');
		return t('BatchUploadDialog.skipUnsupported', { ext: i === -1 ? '?' : name.slice(i).toLowerCase() });
	}

	// Tauri on Linux only: WebKitGTK's file chooser is always "open file", so
	// <input webkitdirectory> cannot pick a folder there. macOS (wry) and
	// Windows (WebView2) handle it natively, and so does every browser.
	let useNativeFolderPicker = $derived(isTauri() && serverPlatform() === 'linux');
	let scanning = $state(false);
	let scanError = $state('');

	/**
	 * Rebuilds the whole queue from one <input type=file> pick — a folder
	 * pick's FileList carries `webkitRelativePath` ("Picked/sub/dir/x.pdf")
	 * on every entry, a plain multi-file pick carries none. Replaces the
	 * previous queue rather than appending: the two pickers are alternatives,
	 * not additive (picking a folder after files discards the file pick, and
	 * vice versa) — matching a single "what will be imported" preview below
	 * instead of a silently merged one a user didn't ask for.
	 */
	function buildEntries(fileList: FileList | null, isFolder: boolean): void {
		if (!fileList || fileList.length === 0) return;

		if (isFolder) {
			const first = fileList[0] as File & { webkitRelativePath?: string };
			const folderName = first.webkitRelativePath?.split('/')[0] ?? '';
			if (folderName && !domain.trim()) domain = folderName;
		}

		const entries: QueueEntry[] = [];
		for (const file of Array.from(fileList)) {
			const relativePath = isFolder ? ((file as File & { webkitRelativePath?: string }).webkitRelativePath ?? '') : '';
			const parts = relativePath.split('/').filter(Boolean);
			// Top segment (the picked folder's own name) and the filename
			// itself are both dropped from relDir — the top segment becomes
			// `domain` above, the filename is sent separately as the file.
			const relDir = parts.length > 2 ? parts.slice(1, -1).join('/') : '';
			// Path inside the picked folder, the unit the shared filter works on.
			const inner = isFolder && parts.length > 1 ? parts.slice(1).join('/') : file.name;
			const reason = skipReasonFor(inner, file.size);
			const base = { key: localKey(), name: file.name, size: file.size, file, relDir };
			entries.push(
				reason ? { ...base, status: 'skipped', reason: skipText(reason, file.name) } : { ...base, status: 'pending' }
			);
		}
		queue = entries;
	}

	function onFilesChange(e: Event) {
		const input = e.currentTarget as HTMLInputElement;
		buildEntries(input.files, false);
	}

	/** Linux desktop: pick a folder with the Tauri dialog, then let the server
	 * scan it (POST /api/import/batch/scan) — same filters as the browser path
	 * (import-filter.ts), and the files are later imported by { scanId, relPath }. */
	async function pickFolderNative() {
		scanError = '';
		try {
			const { open: openFolderDialog } = await import('@tauri-apps/plugin-dialog');
			const picked = await openFolderDialog({ directory: true, multiple: false });
			if (typeof picked !== 'string') return;
			scanning = true;
			const res = await fetch('/api/import/batch/scan', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ root: picked })
			});
			if (!res.ok) throw new Error(await readResponseError(res));
			const data = (await res.json()) as {
				scanId: string;
				folderName: string;
				entries: { relPath: string; size: number; skip?: SkipReason }[];
			};
			if (data.folderName && !domain.trim()) domain = data.folderName;
			queue = data.entries.map((e) => {
				const parts = e.relPath.split('/');
				const name = parts.pop() ?? e.relPath;
				const base = {
					key: localKey(),
					name,
					size: e.size,
					scan: { scanId: data.scanId, relPath: e.relPath },
					relDir: parts.join('/')
				};
				return e.skip
					? { ...base, status: 'skipped' as const, reason: skipText(e.skip, name) }
					: { ...base, status: 'pending' as const };
			});
		} catch (err) {
			scanError = err instanceof Error ? err.message : t('BatchUploadDialog.scanFailed');
		} finally {
			scanning = false;
		}
	}

	function onFolderChange(e: Event) {
		const input = e.currentTarget as HTMLInputElement;
		buildEntries(input.files, true);
	}

	function openDialog() {
		open = true;
		phase = 'idle';
		queue = [];
		domain = '';
		level = 'undergraduate';
		stopRequested = false;
		totalToRun = 0;
		finishedCount = 0;
		parallel = false;
		concurrencyChoice = '2';
		scanning = false;
		scanError = '';
	}

	/** One file, one POST — see +server.ts's doc comment for why: it lets the
	 * Ollama-eviction win apply per file instead of once for a whole batch
	 * stuck behind the slowest document. A network/stream error here marks
	 * just this row failed; the caller loop moves on to the next file. */
	async function runOne(entry: QueueEntry, concurrency: number): Promise<void> {
		const fd = new FormData();
		if (entry.scan) {
			fd.append('scanId', entry.scan.scanId);
			fd.append('relPath', entry.scan.relPath);
		} else if (entry.file) {
			fd.append('files', entry.file);
			fd.append('relDir', entry.relDir);
		}
		fd.append('domain', domain.trim());
		fd.append('level', level);
		fd.append('concurrency', String(concurrency));

		try {
			const res = await fetch('/api/import/batch', { method: 'POST', body: fd });
			// Same 413-has-no-SSE-body reasoning as UploadDialog.upload().
			if (res.status === 413) throw new Error(t('UploadDialog.tooLarge'));
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
						entry.stage = STAGE_LABELS[event.stage] ?? event.stage;
						entry.estimatedSeconds = event.estimatedSeconds ?? entry.estimatedSeconds;
					} else if (event.type === 'item') {
						entry.key = event.item.id;
						entry.status = event.item.status;
						entry.code = event.item.code;
						entry.params = event.item.params;
						entry.reason = event.item.reason;
						entry.path = event.item.path;
					} else if (event.type === 'error') {
						entry.status = 'failed';
						entry.code = event.code;
						entry.params = event.params;
						entry.reason = event.message;
					}
				}
			}
		} catch (err) {
			entry.status = 'failed';
			// Already localized text (readResponseError / t()), no code.
			entry.code = undefined;
			entry.reason = err instanceof Error ? err.message : t('UploadDialog.uploadFailed');
		}
	}

	async function run() {
		if (!domain.trim()) return;
		const toRun = queue.filter((e) => e.status === 'pending');
		if (toRun.length === 0) return;

		const concurrency = parallel ? Math.min(4, Math.max(2, Number.parseInt(concurrencyChoice, 10) || 2)) : 1;
		phase = 'running';
		stopRequested = false;
		totalToRun = toRun.length;
		finishedCount = 0;

		// N workers pulling the next pending entry. nextIndex is only touched
		// synchronously (no await between the stop check and the increment),
		// so no two workers take the same file and none starts a new file
		// after Stop. A file already in flight finishes (same semantic as the
		// old sequential loop).
		let nextIndex = 0;
		const worker = async () => {
			while (!stopRequested && nextIndex < toRun.length) {
				const entry = toRun[nextIndex++];
				entry.running = true;
				entry.stage = STAGE_LABELS.converting;
				entry.estimatedSeconds = undefined;
				await runOne(entry, concurrency);
				entry.running = false;
				finishedCount += 1;
			}
		};
		await Promise.all(Array.from({ length: Math.min(concurrency, toRun.length) }, worker));

		phase = 'done';
		if (queue.some((e) => e.status === 'converted' || e.status === 'needs_review')) onImported();
	}

	function stop() {
		stopRequested = true;
	}

	function close() {
		open = false;
	}
</script>

<Button variant="outline" class="mb-1.5 w-full" onclick={openDialog}>{t('BatchUploadDialog.trigger')}</Button>

<Dialog.Root
	{open}
	onOpenChange={(next) => {
		if (next) {
			open = true;
			return;
		}
		// Same guard as UploadDialog: an outside click/Escape must not close
		// the dialog while the sequential loop is mid-file — that request is
		// already in flight and must finish first.
		if (phase === 'running') return;
		open = false;
	}}
>
	<Dialog.Content class="sm:max-w-lg">
		<Dialog.Header>
			<Dialog.Title>{t('BatchUploadDialog.dialogTitle')}</Dialog.Title>
			<Dialog.Description>{t('BatchUploadDialog.dialogDescription')}</Dialog.Description>
		</Dialog.Header>

		{#if phase === 'idle'}
			<label class="flex flex-col gap-1.5 text-[13px] leading-[18px] font-medium">
				{t('BatchUploadDialog.pickFilesLabel')}
				<Input
					type="file"
					multiple
					onchange={onFilesChange}
					accept=".docx,.pptx,.xlsx,.html,.htm,.epub,.pdf,.md,.tex,.js,.ts,.py,.c,.h,.cpp,.hpp,.rs,.sh,.json,.css,.svelte,.sql,.asm,.s"
				/>
			</label>
			<label class="flex flex-col gap-1.5 text-[13px] leading-[18px] font-medium">
				{t('BatchUploadDialog.pickFolderLabel')}
				{#if useNativeFolderPicker}
					<Button variant="outline" onclick={pickFolderNative} disabled={scanning}>
						{scanning ? t('BatchUploadDialog.scanning') : t('BatchUploadDialog.pickFolderButton')}
					</Button>
					{#if scanError}<span class="text-xs text-destructive" role="alert">{scanError}</span>{/if}
				{:else}
					<Input type="file" multiple webkitdirectory onchange={onFolderChange} />
				{/if}
			</label>

			{#if queue.length > 0}
				<p class="text-sm text-muted-foreground">
					{t('BatchUploadDialog.previewSummary', { allowed: allowedCount, skipped: skippedCount })}
				</p>
				{#if previewTargets.length > 0}
					<ul class="max-h-28 list-disc space-y-0.5 overflow-y-auto pl-5 text-xs text-muted-foreground">
						{#each previewTargets as target (target)}
							<li class="overflow-hidden text-ellipsis whitespace-nowrap">{target}</li>
						{/each}
					</ul>
				{/if}
			{/if}

			<label class="flex flex-col gap-1.5 text-[13px] leading-[18px] font-medium">
				{t('UploadDialog.domainLabel')}
				<Input type="text" bind:value={domain} placeholder={t('UploadDialog.domainPlaceholder')} />
			</label>
			<label class="flex flex-col gap-1.5 text-[13px] leading-[18px] font-medium">
				{t('UploadDialog.levelLabel')}
				<Select.Root type="single" bind:value={level}>
					<Select.Trigger class="w-full">{level}</Select.Trigger>
					<Select.Content>
						<Select.Item value="undergraduate" label="undergraduate">undergraduate</Select.Item>
						<Select.Item value="graduate" label="graduate">graduate</Select.Item>
						<Select.Item value="phd" label="phd">phd</Select.Item>
					</Select.Content>
				</Select.Root>
			</label>

			<div class="flex flex-col gap-1.5 text-sm">
				<label class="flex items-center justify-between gap-2">
					{t('BatchUploadDialog.parallelLabel')}
					<Switch bind:checked={parallel} />
				</label>
				{#if parallel}
					<label class="flex items-center justify-between gap-2">
						{t('BatchUploadDialog.parallelCount')}
						<Select.Root type="single" bind:value={concurrencyChoice}>
							<Select.Trigger class="w-20">{concurrencyChoice}</Select.Trigger>
							<Select.Content>
								<Select.Item value="2" label="2">2</Select.Item>
								<Select.Item value="3" label="3">3</Select.Item>
								<Select.Item value="4" label="4">4</Select.Item>
							</Select.Content>
						</Select.Root>
					</label>
				{/if}
				<p class="text-xs text-muted-foreground">{t('BatchUploadDialog.parallelHelp')}</p>
			</div>

			<Dialog.Footer>
				<Button variant="outline" onclick={close}>{t('Common.iptal')}</Button>
				<Button onclick={run} disabled={!domain.trim() || allowedCount === 0}>{t('BatchUploadDialog.start')}</Button>
			</Dialog.Footer>
		{:else if phase === 'running'}
			<p class="flex items-center gap-2 text-sm text-muted-foreground">
				<span class="inline-block size-3.5 animate-spin rounded-full border-2 border-border border-t-primary" aria-hidden="true"></span>
				{t('BatchUploadDialog.progressCount', { done: finishedCount, total: totalToRun })}
			</p>
			<div class="flex max-h-[40vh] flex-col gap-1 overflow-y-auto">
				{#each queue.filter((e) => e.running) as entry (entry.key)}
					<div class="border-b py-1 text-sm">
						<div class="overflow-hidden text-ellipsis whitespace-nowrap">{entry.name}</div>
						<div class="text-xs text-muted-foreground">
							{entry.stage ?? ''}{#if entry.estimatedSeconds} — {t('UploadDialog.estimatedTime', { seconds: entry.estimatedSeconds })}{/if}
						</div>
					</div>
				{/each}
			</div>
			<Dialog.Footer>
				<Button variant="outline" onclick={stop}>{t('BatchUploadDialog.stop')}</Button>
			</Dialog.Footer>
		{:else if phase === 'done'}
			<div class="mb-1 flex flex-wrap gap-1.5">
				{#each Object.entries(counts) as [status, n] (status)}
					<Badge variant="outline">{STATUS_LABELS[status] ?? status}: {n}</Badge>
				{/each}
			</div>
			<div class="flex max-h-[50vh] flex-col gap-1 overflow-y-auto">
				{#each queue as entry (entry.key)}
					<div class="flex items-center gap-2 border-b py-1 text-sm">
						<span class="shrink-0 rounded-[var(--radius-sm)] px-[7px] py-0 text-[11px] leading-[18px] font-medium {STATUS_BADGE_CLASS[entry.status] ?? ''}">
							{STATUS_LABELS[entry.status] ?? entry.status}
						</span>
						<span class="overflow-hidden text-ellipsis whitespace-nowrap">{targetPath(entry)}</span>
						{#if entry.reason || entry.code}<span class="text-xs text-muted-foreground">{reasonText(entry)}</span>{/if}
					</div>
				{/each}
			</div>
			<Dialog.Footer>
				<Button onclick={close}>{t('Common.kapat')}</Button>
			</Dialog.Footer>
		{/if}
	</Dialog.Content>
</Dialog.Root>
