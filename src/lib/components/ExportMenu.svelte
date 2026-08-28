<script lang="ts">
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import DownloadIcon from '@lucide/svelte/icons/download';
	import { t } from '$lib/i18n/index.svelte';

	let { chatId }: { chatId: string } = $props();
	let errorMessage = $state('');

	/**
	 * Downloads via fetch+Blob into a temporary, never-mounted-in-the-menu
	 * <a> instead of a plain <a href download> inside the DropdownMenu.Item —
	 * the latter raced against bits-ui's own click handler, which closes the
	 * menu (closeOnSelect defaults to true) synchronously in the same click
	 * event that was supposed to trigger the browser's native download
	 * activation, silently breaking both Markdown and JSON export. This is
	 * immune to that regardless of the exact timing, since the triggering
	 * anchor is never part of the menu's DOM tree. Also surfaces a real error
	 * (e.g. the export 404ing for a chat with no persisted messages yet)
	 * instead of a silent/bogus download.
	 */
	async function download(format: 'md' | 'json') {
		errorMessage = '';
		try {
			const res = await fetch(`/api/chats/${chatId}/export?format=${format}`);
			if (!res.ok) {
				throw new Error(
					res.status === 404
						? t('ExportMenu.chatNotSavedYet')
						: t('ExportMenu.downloadFailedWithStatus', { status: res.status })
				);
			}
			const blob = await res.blob();
			const cd = res.headers.get('content-disposition') ?? '';
			const match = cd.match(/filename="([^"]+)"/);
			const filename = match?.[1] ?? `chat.${format}`;
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = filename;
			document.body.appendChild(a);
			a.click();
			a.remove();
			URL.revokeObjectURL(url);
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : t('ExportMenu.downloadFailed');
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
{#if errorMessage}
	<p class="text-xs text-destructive">{errorMessage}</p>
{/if}
