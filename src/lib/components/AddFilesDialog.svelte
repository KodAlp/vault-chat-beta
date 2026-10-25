<script lang="ts">
	import { isTauri } from '@tauri-apps/api/core';
	import { serverPlatform } from '#lib/serverPlatform.svelte.js';
	import { ALLOWED_EXTENSIONS, CODE_EXTENSIONS } from '#lib/import-extensions.js';
	import {
		readDroppedRoots,
		routeFor,
		selectionFromDropped,
		selectionFromFileList,
		type ScanEntry,
		type Selection
	} from '#lib/import-selection.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import SingleFileImport from './SingleFileImport.svelte';
	import BatchImport from './BatchImport.svelte';
	import { t } from '#lib/i18n/index.svelte.js';
	import { readResponseError } from '#lib/server-error.js';

	/**
	 * The ONE upload entry point. The user only says WHAT (files, a folder, a video link); which
	 * flow runs is decided by routeFor() in import-selection.ts: exactly one loose file → the
	 * single-file flow with its review step; several files or any folder → the direct batch flow.
	 */
	let { onImported }: { onImported: () => void } = $props();

	let open = $state(false);
	type Step = 'pick' | 'single' | 'batch';
	let step = $state<Step>('pick');
	let selection = $state.raw<Selection<File> | null>(null);

	// A video link is not a file, but it feeds the same single-item review flow.
	let youtubeMode = $state(false);
	let youtubeUrl = $state('');
	// Rights checkbox, YouTube only — a local file the user picks is already
	// theirs; a YouTube URL is fetched from outside.
	let rightsConfirmed = $state(false);
	let youtubeStarted = $state(false);

	let single = $state<SingleFileImport | undefined>();
	let batch = $state<BatchImport | undefined>();

	let fileInput = $state<HTMLInputElement | undefined>();
	let folderInput = $state<HTMLInputElement | undefined>();

	// Everything the importer can route on (documents + code), so the OS file chooser greys out the rest.
	const ACCEPT = [...ALLOWED_EXTENSIONS, ...CODE_EXTENSIONS].join(',');

	// Tauri on Linux only: WebKitGTK's file chooser is always "open file", so
	// <input webkitdirectory> cannot pick a folder there. macOS (wry) and
	// Windows (WebView2) handle it natively, and so does every browser.
	let useNativeFolderPicker = $derived(isTauri() && serverPlatform() === 'linux');
	// Browser only: inside Tauri the WebView's file drops are intercepted by the host (they never
	// reach the page as DOM events), so a drop zone there would be a lie.
	let canDrop = $derived(!isTauri());

	let busy = $state(false);
	let pickError = $state('');
	let dragging = $state(false);

	function openDialog() {
		open = true;
		step = 'pick';
		selection = null;
		youtubeMode = false;
		youtubeUrl = '';
		rightsConfirmed = false;
		youtubeStarted = false;
		busy = false;
		pickError = '';
		dragging = false;
	}

	/** Back to the picker (also remounts the inner flow, so a new pick starts clean). */
	function toPick() {
		step = 'pick';
		selection = null;
		youtubeStarted = false;
		pickError = '';
	}

	function apply(sel: Selection<File>) {
		const route = routeFor(sel);
		if (route === 'none') return;
		selection = sel;
		step = route;
	}

	function onFilesChange(e: Event, isFolder: boolean) {
		const input = e.currentTarget as HTMLInputElement;
		const files = Array.from(input.files ?? []);
		// Clearing lets picking the very same file/folder again fire a change event.
		input.value = '';
		if (files.length === 0) return;
		apply(selectionFromFileList(files, isFolder));
	}

	/** Linux desktop: pick a folder with the Tauri dialog, then let the server
	 * scan it (POST /api/import/batch/scan) — same filters as the browser path
	 * (import-filter.ts), and the files are later imported by { scanId, relPath }. */
	async function pickFolderNative() {
		pickError = '';
		try {
			const { open: openFolderDialog } = await import('@tauri-apps/plugin-dialog');
			const picked = await openFolderDialog({ directory: true, multiple: false });
			if (typeof picked !== 'string') return;
			busy = true;
			const res = await fetch('/api/import/batch/scan', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ root: picked })
			});
			if (!res.ok) throw new Error(await readResponseError(res));
			const data = (await res.json()) as { scanId: string; folderName: string; entries: ScanEntry[] };
			apply({ kind: 'scan', scanId: data.scanId, folderName: data.folderName, entries: data.entries });
		} catch (err) {
			pickError = err instanceof Error ? err.message : t('AddFilesDialog.scanFailed');
		} finally {
			busy = false;
		}
	}

	function onDragOver(e: DragEvent) {
		// Without preventDefault the browser would navigate to the dropped file.
		e.preventDefault();
		if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
		dragging = true;
	}

	async function onDrop(e: DragEvent) {
		e.preventDefault();
		dragging = false;
		if (!e.dataTransfer || busy) return;
		pickError = '';
		busy = true;
		try {
			// readDroppedRoots takes every entry before its first await — required, the
			// DataTransfer is dead once this handler yields.
			const roots = await readDroppedRoots<File>(e.dataTransfer.items);
			if (roots.length > 0) apply(selectionFromDropped(roots));
		} catch (err) {
			pickError = err instanceof Error ? err.message : t('AddFilesDialog.scanFailed');
		} finally {
			busy = false;
		}
	}

	function startYoutube() {
		if (!youtubeUrl.trim() || !rightsConfirmed) return;
		youtubeStarted = true;
		step = 'single';
	}

	async function requestClose() {
		if (step === 'single') {
			if (single?.isBusy()) return;
			await single?.discard();
		} else if (step === 'batch' && batch?.isBusy()) {
			return;
		}
		open = false;
	}

	function imported() {
		onImported();
	}
</script>

<Button variant="outline" class="mb-1.5 w-full" onclick={openDialog}>{t('AddFilesDialog.trigger')}</Button>

<Dialog.Root
	{open}
	onOpenChange={(next) => {
		if (next) {
			open = true;
			return;
		}
		void requestClose();
	}}
>
	<Dialog.Content class="sm:max-w-lg">
		<Dialog.Header>
			<Dialog.Title>{t('AddFilesDialog.dialogTitle')}</Dialog.Title>
			{#if step === 'pick'}
				<Dialog.Description>{t('AddFilesDialog.dialogDescription')}</Dialog.Description>
			{/if}
		</Dialog.Header>

		{#if step === 'pick'}
			{#if !youtubeMode}
				<div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
					<Button variant="outline" class="h-auto min-h-9 whitespace-normal" onclick={() => fileInput?.click()} disabled={busy}>
						{t('AddFilesDialog.pickFilesButton')}
					</Button>
					{#if useNativeFolderPicker}
						<Button variant="outline" class="h-auto min-h-9 whitespace-normal" onclick={pickFolderNative} disabled={busy}>
							{busy ? t('AddFilesDialog.scanning') : t('AddFilesDialog.pickFolderButton')}
						</Button>
					{:else}
						<Button variant="outline" class="h-auto min-h-9 whitespace-normal" onclick={() => folderInput?.click()} disabled={busy}>
							{busy ? t('AddFilesDialog.scanning') : t('AddFilesDialog.pickFolderButton')}
						</Button>
					{/if}
				</div>
				<!-- Programmatically clicked by the buttons above; hidden so the two pickers read as
				     equal buttons instead of two stock file inputs. -->
				<input
					bind:this={fileInput}
					type="file"
					multiple
					accept={ACCEPT}
					class="hidden"
					tabindex="-1"
					aria-hidden="true"
					onchange={(e) => onFilesChange(e, false)}
				/>
				<input
					bind:this={folderInput}
					type="file"
					multiple
					webkitdirectory
					class="hidden"
					tabindex="-1"
					aria-hidden="true"
					onchange={(e) => onFilesChange(e, true)}
				/>

				{#if canDrop}
					<!-- The buttons stay the keyboard path; this is the pointer shortcut. -->
					<div
						class="dropzone"
						class:dragging
						role="presentation"
						ondragover={onDragOver}
						ondragleave={() => (dragging = false)}
						ondrop={onDrop}
					>
						{busy ? t('AddFilesDialog.scanning') : t('AddFilesDialog.dropHint')}
					</div>
				{/if}
				{#if pickError}<p class="text-xs text-destructive" role="alert">{pickError}</p>{/if}

				<Button variant="link" size="sm" class="self-start px-0" onclick={() => (youtubeMode = true)}>
					{t('AddFilesDialog.youtubeToggle')}
				</Button>
				<Dialog.Footer>
					<Button variant="outline" onclick={requestClose}>{t('Common.iptal')}</Button>
				</Dialog.Footer>
			{:else}
				<label class="flex flex-col gap-1.5 text-[13px] leading-[18px] font-medium">
					{t('AddFilesDialog.youtubeLabel')}
					<Input type="url" bind:value={youtubeUrl} placeholder={t('AddFilesDialog.youtubePlaceholder')} />
				</label>
				<label class="flex items-start gap-2 text-xs text-muted-foreground">
					<input type="checkbox" bind:checked={rightsConfirmed} class="mt-0.5" />
					{t('AddFilesDialog.youtubeRightsConfirm')}
				</label>
				<Dialog.Footer>
					<Button variant="outline" onclick={() => (youtubeMode = false)}>{t('AddFilesDialog.back')}</Button>
					<Button onclick={startYoutube} disabled={!youtubeUrl.trim() || !rightsConfirmed}>{t('AddFilesDialog.youtubeUpload')}</Button>
				</Dialog.Footer>
			{/if}
		{:else if step === 'single'}
			{#if youtubeStarted}
				<SingleFileImport bind:this={single} {youtubeUrl} onImported={() => { imported(); open = false; }} onClose={() => (open = false)} onBack={toPick} />
			{:else if selection?.kind === 'items'}
				<SingleFileImport bind:this={single} file={selection.items[0].file} onImported={() => { imported(); open = false; }} onClose={() => (open = false)} onBack={toPick} />
			{/if}
		{:else if selection}
			<BatchImport bind:this={batch} {selection} onImported={imported} onClose={() => (open = false)} onBack={toPick} />
		{/if}
	</Dialog.Content>
</Dialog.Root>

<style>
	.dropzone {
		display: grid;
		place-items: center;
		padding: var(--space-5, 20px) var(--space-4, 16px);
		border: 1.5px dashed var(--separator-strong);
		border-radius: var(--radius-lg);
		color: var(--label-secondary);
		font: 400 13px/18px var(--font-sans);
		text-align: center;
		transition: background-color var(--duration-fast), border-color var(--duration-fast);
	}
	.dropzone.dragging {
		background: var(--accent-soft);
		border-color: var(--accent-text);
		color: var(--accent-text);
	}
</style>
