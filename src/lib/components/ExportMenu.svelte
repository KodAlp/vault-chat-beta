<script lang="ts">
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import DownloadIcon from '@lucide/svelte/icons/download';

	let { chatId }: { chatId: string } = $props();
</script>

<DropdownMenu.Root>
	<DropdownMenu.Trigger
		class="flex border-none bg-transparent p-1 -m-1 leading-none text-muted-foreground hover:text-primary focus-visible:outline-2 focus-visible:outline-[var(--accent)] focus-visible:outline-offset-2"
		title="Dışa aktar"
		aria-label="Dışa aktar"
	>
		<DownloadIcon size={17} aria-hidden="true" />
	</DropdownMenu.Trigger>
	<DropdownMenu.Content align="end">
		<DropdownMenu.Item>
			{#snippet child({ props })}
				<a {...props} href="/api/chats/{chatId}/export?format=md" download>Markdown (.md)</a>
			{/snippet}
		</DropdownMenu.Item>
		<DropdownMenu.Item>
			{#snippet child({ props })}
				<a {...props} href="/api/chats/{chatId}/export?format=json" download>JSON (.json)</a>
			{/snippet}
		</DropdownMenu.Item>
	</DropdownMenu.Content>
</DropdownMenu.Root>
