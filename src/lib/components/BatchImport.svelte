<script lang="ts">
	import type { ImportEvent, ImportResultStatus } from '#lib/types.js';
	import type { SkipReason } from '#lib/import-filter.js';
	import { seedsFromSelection, type Selection } from '#lib/import-selection.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import * as Select from '#lib/components/ui/select/index.js';
	import { Switch } from '#lib/components/ui/switch/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import { t } from '#lib/i18n/index.svelte.js';
	import { localizeError, readResponseError } from '#lib/server-error.js';

	/**
	 * The several-files / folder flow inside AddFilesDialog (formerly the body of BatchUploadDialog):
	 * preview what will be imported, pick domain/level/concurrency, then one POST per file with
	 * per-file progress. The parent owns the <Dialog> and the picking; it asks isBusy() before closing.
	 */
	let {
		selection,
		onImported,
		onClose,
		onBack
	}: {
		selection: Selection<File>;
		onImported: () => void;
		onClose: () => void;
		onBack: () => void;
	} = $props();

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
		// (see import-selection.ts) — this is exactly the `relDir` the server
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

	function skipText(reason: SkipReason, name: string): string {
		if (reason === 'junk') return t('BatchImport.skipJunk');
		if (reason === 'tooLarge') return t('BatchImport.skipTooLarge');
		if (reason === 'tooDeep') return t('BatchImport.skipTooDeep');
		const i = name.lastIndexOf('.');
		return t('BatchImport.skipUnsupported', { ext: i === -1 ? '?' : name.slice(i).toLowerCase() });
	}

	// The selection is fixed for this component's life (picking again goes back to the picker
	// and remounts), so reading the prop once here is intended.
	// svelte-ignore state_referenced_locally
	const initial = selection;
	let queue = $state<QueueEntry[]>(
		seedsFromSelection(initial).map((seed) => {
			const base = { key: localKey(), name: seed.name, size: seed.size, file: seed.file, scan: seed.scan, relDir: seed.relDir };
			return seed.skip
				? { ...base, status: 'skipped' as const, reason: skipText(seed.skip, seed.name) }
				: { ...base, status: 'pending' as const };
		})
	);
	// A folder pick names the domain; loose files leave it for the user to type.
	let domain = $state(initial.folderName);
	let level = $state('undergraduate');
	// Per-import OCR language for scanned pages; '' = the vault's own language(s) (server default).
	// Only languages the bundled OCR model reads (ingest/ocr_lang.py); names come from the browser's locale data.
	const OCR_LANGS = ['tr', 'en', 'de', 'fr', 'es', 'it', 'pt', 'nl', 'pl', 'zh', 'ja'];
	let ocrLang = $state('');
	const ocrLangLabel = (code: string) => {
		if (!code) return t('ImportFlow.ocrLangVault');
		try {
			return new Intl.DisplayNames(undefined, { type: 'language' }).of(code) ?? code;
		} catch {
			return code;
		}
	};
	// Level values are stored as English enums; the shown label is translated (ImportFlow.level*).
	const levelLabel = (v: string) =>
		v === 'graduate' ? t('ImportFlow.levelGraduate') : v === 'phd' ? t('ImportFlow.levelPhd') : t('ImportFlow.levelUndergraduate');

	type Phase = 'idle' | 'running' | 'done';
	let phase = $state<Phase>('idle');

	// Session-only, not persisted: off = one file at a time (the old behavior).
	let parallel = $state(false);
	let concurrencyChoice = $state('2');

	let stopRequested = false;
	let totalToRun = $state(0);
	let finishedCount = $state(0);

	// $derived, not a plain const — see +layout.svelte's identical STAGE_LABELS
	// comment: a bare object literal would call t() once at component init and
	// freeze at whatever locale was active then. Shares the single-file flow's
	// stage strings (convert.py emits the same stage names for every caller).
	let STAGE_LABELS = $derived<Record<string, string>>({
		queued: t('ImportFlow.stageQueued'),
		converting: t('ImportFlow.stageConverting'),
		postprocessing: t('ImportFlow.stagePostprocessing'),
		retrying: t('ImportFlow.stageRetrying')
	});

	let STATUS_LABELS = $derived<Record<string, string>>({
		converted: t('BatchImport.statusConverted'),
		skipped: t('BatchImport.statusSkipped'),
		needs_review: t('BatchImport.statusNeedsReview'),
		failed: t('BatchImport.statusFailed'),
		pending: t('BatchImport.statusPending')
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

	/** Not while a file is in flight: that request must finish first (same guard the old dialog had). */
	export function isBusy(): boolean {
		return phase === 'running';
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
		if (ocrLang) fd.append('ocrLang', ocrLang);
		fd.append('concurrency', String(concurrency));

		try {
			const res = await fetch('/api/import/batch', { method: 'POST', body: fd });
			// Same 413-has-no-SSE-body reasoning as SingleFileImport.upload().
			if (res.status === 413) throw new Error(t('ImportFlow.tooLarge'));
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
			entry.reason = err instanceof Error ? err.message : t('ImportFlow.uploadFailed');
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
</script>

{#if phase === 'idle'}
	<p class="text-sm text-muted-foreground">{t('BatchImport.description')}</p>
	<p class="text-sm text-muted-foreground">
		{t('BatchImport.previewSummary', { allowed: allowedCount, skipped: skippedCount })}
	</p>
	{#if previewTargets.length > 0}
		<ul class="max-h-28 list-disc space-y-0.5 overflow-y-auto ps-5 text-xs text-muted-foreground">
			{#each previewTargets as target (target)}
				<li class="overflow-hidden text-ellipsis whitespace-nowrap">{target}</li>
			{/each}
		</ul>
	{/if}

	<label class="flex flex-col gap-1.5 text-[13px] leading-[18px] font-medium">
		{t('ImportFlow.domainLabel')}
		<Input type="text" bind:value={domain} placeholder={t('ImportFlow.domainPlaceholder')} />
	</label>
	<label class="flex flex-col gap-1.5 text-[13px] leading-[18px] font-medium">
		{t('ImportFlow.levelLabel')}
		<Select.Root type="single" bind:value={level}>
			<Select.Trigger class="w-full">{levelLabel(level)}</Select.Trigger>
			<Select.Content>
				<Select.Item value="undergraduate" label={t('ImportFlow.levelUndergraduate')}>{t('ImportFlow.levelUndergraduate')}</Select.Item>
				<Select.Item value="graduate" label={t('ImportFlow.levelGraduate')}>{t('ImportFlow.levelGraduate')}</Select.Item>
				<Select.Item value="phd" label={t('ImportFlow.levelPhd')}>{t('ImportFlow.levelPhd')}</Select.Item>
			</Select.Content>
		</Select.Root>
	</label>
	<label class="flex flex-col gap-1.5 text-[13px] leading-[18px] font-medium">
		{t('ImportFlow.ocrLangLabel')}
		<Select.Root type="single" bind:value={ocrLang}>
			<Select.Trigger class="w-full">{ocrLangLabel(ocrLang)}</Select.Trigger>
			<Select.Content>
				<Select.Item value="" label={t('ImportFlow.ocrLangVault')}>{t('ImportFlow.ocrLangVault')}</Select.Item>
				{#each OCR_LANGS as code (code)}
					<Select.Item value={code} label={ocrLangLabel(code)}>{ocrLangLabel(code)}</Select.Item>
				{/each}
			</Select.Content>
		</Select.Root>
	</label>

	<div class="flex flex-col gap-1.5 text-sm">
		<label class="flex items-center justify-between gap-2">
			{t('BatchImport.parallelLabel')}
			<Switch bind:checked={parallel} />
		</label>
		{#if parallel}
			<label class="flex items-center justify-between gap-2">
				{t('BatchImport.parallelCount')}
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
		<p class="text-xs text-muted-foreground">{t('BatchImport.parallelHelp')}</p>
	</div>

	<Dialog.Footer>
		<Button variant="outline" onclick={onBack}>{t('AddFilesDialog.back')}</Button>
		<Button onclick={run} disabled={!domain.trim() || allowedCount === 0}>{t('BatchImport.start')}</Button>
	</Dialog.Footer>
{:else if phase === 'running'}
	<p class="flex items-center gap-2 text-sm text-muted-foreground">
		<span class="inline-block size-3.5 animate-spin rounded-full border-2 border-border border-t-primary" aria-hidden="true"></span>
		{t('BatchImport.progressCount', { done: finishedCount, total: totalToRun })}
	</p>
	<div class="flex max-h-[40vh] flex-col gap-1 overflow-y-auto">
		{#each queue.filter((e) => e.running) as entry (entry.key)}
			<div class="border-b py-1 text-sm">
				<div class="overflow-hidden text-ellipsis whitespace-nowrap">{entry.name}</div>
				<div class="text-xs text-muted-foreground">
					{entry.stage ?? ''}{#if entry.estimatedSeconds} — {t('ImportFlow.estimatedTime', { seconds: entry.estimatedSeconds })}{/if}
				</div>
			</div>
		{/each}
	</div>
	<Dialog.Footer>
		<Button variant="outline" onclick={stop}>{t('BatchImport.stop')}</Button>
	</Dialog.Footer>
{:else}
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
		<Button onclick={onClose}>{t('Common.kapat')}</Button>
	</Dialog.Footer>
{/if}
