<script lang="ts">
	import type { ImportEvent, ImportResultStatus } from '$lib/types';
	import { ALLOWED_EXTENSIONS, CODE_EXTENSIONS, MAX_UPLOAD_BYTES } from '$lib/import-extensions';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Badge } from '$lib/components/ui/badge';
	import * as Select from '$lib/components/ui/select';
	import * as Dialog from '$lib/components/ui/dialog';
	import { t } from '$lib/i18n/index.svelte';
	import { localizeError, readResponseError } from '$lib/server-error';

	let { onImported }: { onImported: () => void } = $props();

	// Union of both lists (Aşama 11's client-side pre-filter, see
	// $lib/import-extensions.ts's doc comment): a code file and a "real
	// document" both reach /api/import/batch, which itself checks the same
	// two sets — this is purely so the preview count/skip-reason shown here
	// matches what the server will actually do, not a security boundary.
	const ALL_EXTENSIONS = new Set([...ALLOWED_EXTENSIONS, ...CODE_EXTENSIONS]);

	interface QueueEntry {
		// Stable {#each} key: a client-local id until the server answers, then
		// that item's server-assigned id (ImportResultItem.id). A name-based
		// key would collide for two same-named files in one folder pick.
		key: string;
		file: File;
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

	let stopRequested = false;
	let totalToRun = $state(0);
	let currentIndex = $state(0);
	let currentFileName = $state('');
	let statusLabel = $state('');
	let estimatedSeconds = $state<number | null>(null);

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
		converted: 'bg-primary/15 text-primary',
		needs_review: 'bg-orange-500/20 text-amber-700 dark:text-amber-400',
		failed: 'bg-destructive/15 text-destructive'
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
		return entry.relDir ? `${dirLabel}/${entry.relDir}/${entry.file.name}` : `${dirLabel}/${entry.file.name}`;
	}

	function extOf(name: string): string {
		const i = name.lastIndexOf('.');
		return i === -1 ? '' : name.slice(i).toLowerCase();
	}

	// __MACOSX (macOS zip export junk) and .git (an accidentally-picked repo
	// checkout) are folder NAMES that can appear anywhere in a picked tree,
	// not just at its root — checked against every segment, not just the
	// first, since a folder pick can nest arbitrarily deep.
	function hasJunkSegment(relativePath: string): boolean {
		return relativePath.split('/').some((seg) => seg === '__MACOSX' || seg === '.git');
	}

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
			// itself are both dropped — the top segment becomes `domain`
			// above, the filename is sent separately as the file itself.
			const relDir = parts.length > 2 ? parts.slice(1, -1).join('/') : '';
			const baseName = file.name;

			if (hasJunkSegment(relativePath) || baseName.toLowerCase() === 'desktop.ini' || baseName.startsWith('.')) {
				entries.push({ key: localKey(), file, relDir, status: 'skipped', reason: t('BatchUploadDialog.skipJunk') });
				continue;
			}
			if (file.size > MAX_UPLOAD_BYTES) {
				entries.push({ key: localKey(), file, relDir, status: 'skipped', reason: t('BatchUploadDialog.skipTooLarge') });
				continue;
			}
			const ext = extOf(baseName);
			if (!ALL_EXTENSIONS.has(ext)) {
				entries.push({
					key: localKey(),
					file,
					relDir,
					status: 'skipped',
					reason: t('BatchUploadDialog.skipUnsupported', { ext: ext || '?' })
				});
				continue;
			}
			entries.push({ key: localKey(), file, relDir, status: 'pending' });
		}
		queue = entries;
	}

	function onFilesChange(e: Event) {
		const input = e.currentTarget as HTMLInputElement;
		buildEntries(input.files, false);
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
		currentIndex = 0;
		currentFileName = '';
		statusLabel = '';
		estimatedSeconds = null;
	}

	/** One file, one POST — see +server.ts's doc comment for why: it lets the
	 * Ollama-eviction win apply per file instead of once for a whole batch
	 * stuck behind the slowest document. A network/stream error here marks
	 * just this row failed; the caller loop moves on to the next file. */
	async function runOne(entry: QueueEntry): Promise<void> {
		const fd = new FormData();
		fd.append('files', entry.file);
		fd.append('domain', domain.trim());
		fd.append('level', level);
		fd.append('relDir', entry.relDir);

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
						statusLabel = STAGE_LABELS[event.stage] ?? event.stage;
						estimatedSeconds = event.estimatedSeconds ?? estimatedSeconds;
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

		phase = 'running';
		stopRequested = false;
		totalToRun = toRun.length;
		currentIndex = 0;

		for (const entry of toRun) {
			if (stopRequested) break;
			currentIndex += 1;
			currentFileName = entry.file.name;
			statusLabel = STAGE_LABELS.converting;
			estimatedSeconds = null;
			await runOne(entry);
		}

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
			<label class="flex flex-col gap-1 text-sm">
				{t('BatchUploadDialog.pickFilesLabel')}
				<Input
					type="file"
					multiple
					onchange={onFilesChange}
					accept=".docx,.pptx,.xlsx,.html,.htm,.epub,.pdf,.md,.tex,.js,.ts,.py,.c,.h,.cpp,.hpp,.rs,.sh,.json,.css,.svelte,.sql,.asm,.s"
				/>
			</label>
			<label class="flex flex-col gap-1 text-sm">
				{t('BatchUploadDialog.pickFolderLabel')}
				<Input type="file" multiple webkitdirectory onchange={onFolderChange} />
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

			<label class="flex flex-col gap-1 text-sm">
				{t('UploadDialog.domainLabel')}
				<Input type="text" bind:value={domain} placeholder={t('UploadDialog.domainPlaceholder')} />
			</label>
			<label class="flex flex-col gap-1 text-sm">
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

			<Dialog.Footer>
				<Button variant="outline" onclick={close}>{t('Common.iptal')}</Button>
				<Button onclick={run} disabled={!domain.trim() || allowedCount === 0}>{t('BatchUploadDialog.start')}</Button>
			</Dialog.Footer>
		{:else if phase === 'running'}
			<p class="flex items-center gap-2 text-sm text-muted-foreground">
				<span class="inline-block size-3.5 animate-spin rounded-full border-2 border-border border-t-primary" aria-hidden="true"></span>
				{t('BatchUploadDialog.progressHeader', { current: currentIndex, total: totalToRun, fileName: currentFileName, stage: statusLabel })}
			</p>
			{#if estimatedSeconds}
				<p class="text-xs text-muted-foreground">{t('UploadDialog.estimatedTime', { seconds: estimatedSeconds })}</p>
			{/if}
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
						<span class="shrink-0 rounded-full px-2 py-0.5 text-[0.68rem] {STATUS_BADGE_CLASS[entry.status] ?? ''}">
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
