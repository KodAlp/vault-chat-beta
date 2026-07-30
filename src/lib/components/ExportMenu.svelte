<script lang="ts">
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';

	let { chatId }: { chatId: string } = $props();
</script>

<DropdownMenu.Root>
	<DropdownMenu.Trigger
		class="border-none bg-transparent p-0 leading-none text-muted-foreground hover:text-primary"
		title="Dışa aktar"
	>
		⬇
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
