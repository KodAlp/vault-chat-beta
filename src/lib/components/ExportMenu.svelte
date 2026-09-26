<script lang="ts">
	import { onDestroy } from 'svelte';
	import { motionFly } from '$lib/motion';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import DownloadIcon from '@lucide/svelte/icons/download';
	import CheckIcon from '@lucide/svelte/icons/check';
	import XIcon from '@lucide/svelte/icons/x';
	import { isTauri, invoke } from '@tauri-apps/api/core';
	import { t } from '$lib/i18n/index.svelte';

	let { chatId }: { chatId: string } = $props();
	let errorMessage = $state('');
	let successMessage = $state('');

	/**
	 * Auto-dismiss for the success toast below (İdeas.txt: the saved path
	 * used to sit as permanent static text under the download button until
	 * the NEXT export overwrote it — no confirmation that it was ever read,
	 * no way to make it go away). 4s is long enough to read a filename or a
	 * short path, short enough not to linger. errorMessage is deliberately
	 * NOT put through this — a failure staying visible until the user acts
	 * again is the point; only the success confirmation is transient.
	 */
	const SUCCESS_TOAST_MS = 4000;
	let dismissTimer: ReturnType<typeof setTimeout> | undefined;

	function showSuccess(message: string) {
		successMessage = message;
		clearTimeout(dismissTimer);
		dismissTimer = setTimeout(() => {
			successMessage = '';
		}, SUCCESS_TOAST_MS);
	}

	onDestroy(() => clearTimeout(dismissTimer));

	/**
	 * Export used to be silent on success: the file left through the browser's
	 * download path and the UI said nothing, so there was no confirmation it
	 * worked and no way to learn where it landed.
	 *
	 * The two environments genuinely differ and are handled differently rather
	 * than papered over:
	 * - Desktop (Tauri): the OS save dialog picks the destination, so the exact
	 *   path is known and is what the confirmation shows.
	 * - Browser: the download goes wherever the browser is configured to put
	 *   it, and the page is not allowed to know that. Claiming a path there
	 *   would be a guess, so it confirms the filename instead.
	 */
	async function fetchExport(format: 'md' | 'json'): Promise<{ text: string; filename: string }> {
		const res = await fetch(`/api/chats/${chatId}/export?format=${format}`);
		if (!res.ok) {
			throw new Error(
				res.status === 404
					? t('ExportMenu.chatNotSavedYet')
					: t('ExportMenu.downloadFailedWithStatus', { status: res.status })
			);
		}
		const cd = res.headers.get('content-disposition') ?? '';
		const match = cd.match(/filename="([^"]+)"/);
		return { text: await res.text(), filename: match?.[1] ?? `chat.${format}` };
	}

	/**
	 * Blob + a temporary, never-mounted-in-the-menu <a> rather than a plain
	 * <a href download> inside the DropdownMenu.Item — the latter raced against
	 * bits-ui's own click handler, which closes the menu (closeOnSelect
	 * defaults to true) synchronously in the same click event that was meant to
	 * trigger the browser's native download, silently breaking both formats.
	 * The triggering anchor here is never part of the menu's DOM tree, so the
	 * timing cannot matter.
	 */
	function browserDownload(text: string, filename: string) {
		const url = URL.createObjectURL(new Blob([text]));
		const a = document.createElement('a');
		a.href = url;
		a.download = filename;
		document.body.appendChild(a);
		a.click();
		a.remove();
		URL.revokeObjectURL(url);
	}

	async function download(format: 'md' | 'json') {
		errorMessage = '';
		successMessage = '';
		try {
			const { text, filename } = await fetchExport(format);

			if (isTauri()) {
				const { save } = await import('@tauri-apps/plugin-dialog');
				const path = await save({
					title: t('ExportMenu.saveDialogTitle'),
					defaultPath: filename,
					filters: [{ name: format === 'md' ? 'Markdown' : 'JSON', extensions: [format] }]
				});
				// null means the user dismissed the picker — an ordinary outcome,
				// so it gets a neutral notice rather than an error.
				if (path === null) {
					showSuccess(t('ExportMenu.saveCancelled'));
					return;
				}
				// write_text_file, not tauri-plugin-fs: see src-tauri/src/lib.rs.
				await invoke('write_text_file', { path, contents: text });
				showSuccess(t('ExportMenu.savedTo', { path }));
				return;
			}

			browserDownload(text, filename);
			showSuccess(t('ExportMenu.downloaded', { filename }));
		} catch (err) {
			// write_text_file (src-tauri/src/lib.rs) rejects with a plain
			// String, not a JS Error, so the real OS-level reason must be
			// read as a string too — otherwise it's silently discarded and
			// every desktop failure shows the same generic message.
			const reason =
				err instanceof Error
					? err.message
					: typeof err === 'string'
						? err
						: t('ExportMenu.downloadFailed');
			// A failure inside the desktop save path is about writing the file,
			// not about downloading it, so it says so.
			errorMessage = isTauri() ? t('ExportMenu.saveFailed', { reason }) : reason;
		}
	}
</script>

<DropdownMenu.Root>
	<DropdownMenu.Trigger
		class="flex border-none bg-transparent p-1 -m-1 leading-none text-muted-foreground hover:text-primary focus-visible:outline-2 focus-visible:outline-[var(--accent)] focus-visible:outline-offset-2"
		title={t('ExportMenu.exportTitle')}
		aria-label={t('ExportMenu.exportTitle')}
	>
		<DownloadIcon size={17} aria-hidden="true" />
	</DropdownMenu.Trigger>
	<DropdownMenu.Content align="end">
		<DropdownMenu.Item onSelect={() => download('md')}>{t('ExportMenu.markdown')}</DropdownMenu.Item>
		<DropdownMenu.Item onSelect={() => download('json')}>{t('ExportMenu.json')}</DropdownMenu.Item>
	</DropdownMenu.Content>
</DropdownMenu.Root>
<!-- Floating, staying-until-dismissed error toast (see the comment on
     SUCCESS_TOAST_MS for why success and error are handled differently —
     errorMessage is never auto-cleared, only by the next download() call or
     the button below). This used to render in-flow inside .panel-right, a
     56px-wide icon rail, where any real message wrapped character-by-
     character down the screen edge; it now shares successMessage's fixed
     bottom-left placement instead. -->
<div aria-live="polite" aria-atomic="true">
	{#if errorMessage}
		<div
			class="fixed bottom-5 left-5 z-[200] flex max-w-[min(360px,80vw)] items-center gap-2.5 rounded-full border border-destructive bg-background px-4 py-2.5 text-sm text-destructive break-all"
			style="box-shadow: 0 2px 8px var(--accent-glow)"
			role="alert"
			transition:motionFly={{ y: 12 }}
		>
			{errorMessage}
			<button
				type="button"
				class="flex shrink-0 border-none bg-transparent p-0 text-inherit"
				onclick={() => (errorMessage = '')}
				title={t('Common.kapat')}
				aria-label={t('Common.kapat')}
			>
				<XIcon size={14} aria-hidden="true" />
			</button>
		</div>
	{/if}
</div>

<!-- Floating, auto-dismissing confirmation — same visual language as
     GenerationStatusToast (rounded pill, fly transition) but deliberately
     anchored bottom-LEFT rather than that component's bottom-right: up to
     5 generation toasts can already be stacked there (+layout.svelte), and
     exporting a chat while one is generating is a completely ordinary
     thing to do at the same time. A separate corner needs no coordination
     with that stack's bottom-offset arithmetic. -->
<div aria-live="polite" aria-atomic="true">
	{#if successMessage}
		<div
			class="fixed bottom-5 left-5 z-[200] flex max-w-[min(360px,80vw)] items-center gap-2.5 rounded-full border bg-background px-4 py-2.5 text-sm break-all"
			style="box-shadow: 0 2px 8px var(--accent-glow)"
			transition:motionFly={{ y: 12 }}
		>
			<CheckIcon size={14} class="shrink-0 text-emerald-600" aria-hidden="true" />
			{successMessage}
		</div>
	{/if}
</div>
