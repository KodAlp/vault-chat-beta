<script lang="ts">
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import DownloadIcon from '@lucide/svelte/icons/download';
	import CheckIcon from '@lucide/svelte/icons/check';
	import { isTauri, invoke } from '@tauri-apps/api/core';
	import { t } from '$lib/i18n/index.svelte';

	let { chatId }: { chatId: string } = $props();
	let errorMessage = $state('');
	let successMessage = $state('');

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
					successMessage = t('ExportMenu.saveCancelled');
					return;
				}
				// write_text_file, not tauri-plugin-fs: see src-tauri/src/lib.rs.
				await invoke('write_text_file', { path, contents: text });
				successMessage = t('ExportMenu.savedTo', { path });
				return;
			}

			browserDownload(text, filename);
			successMessage = t('ExportMenu.downloaded', { filename });
		} catch (err) {
			const reason = err instanceof Error ? err.message : t('ExportMenu.downloadFailed');
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
<!-- One live region wrapping both outcomes, so a screen reader announces the
     swap between them instead of only whichever node happened to exist when
     the region was registered. -->
<div aria-live="polite">
	{#if successMessage}
		<p class="flex items-start gap-1 text-xs break-all text-muted-foreground">
			<CheckIcon size={12} class="mt-0.5 shrink-0 text-emerald-600" aria-hidden="true" />
			{successMessage}
		</p>
	{/if}
	{#if errorMessage}
		<p class="text-xs break-all text-destructive">{errorMessage}</p>
	{/if}
</div>
