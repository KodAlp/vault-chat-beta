<script lang="ts">
	let { chatId }: { chatId: string } = $props();

	let open = $state(false);
	let menuEl: HTMLDivElement | undefined;

	function toggle() {
		open = !open;
	}

	function close() {
		open = false;
	}

	$effect(() => {
		if (!open) return;
		function handleClick(e: MouseEvent) {
			if (menuEl && !menuEl.contains(e.target as Node)) close();
		}
		document.addEventListener('click', handleClick);
		return () => document.removeEventListener('click', handleClick);
	});
</script>

<div class="export-menu" bind:this={menuEl}>
	<button onclick={toggle} title="Dışa aktar" aria-expanded={open} aria-haspopup="true">⬇</button>
	{#if open}
		<div class="menu">
			<a href="/api/chats/{chatId}/export?format=md" download onclick={close}>Markdown (.md)</a>
			<a href="/api/chats/{chatId}/export?format=json" download onclick={close}>JSON (.json)</a>
		</div>
	{/if}
</div>

<style>
	.export-menu {
		position: relative;
	}

	.export-menu > button {
		background: transparent;
		border: none;
		color: var(--muted-foreground);
		font-size: 0.9rem;
		cursor: pointer;
		padding: 0;
		line-height: 1;
	}

	.export-menu > button:hover {
		color: var(--primary);
	}

	.menu {
		position: absolute;
		right: 100%;
		top: 0;
		margin-right: 0.5rem;
		background: var(--background);
		border: 1px solid var(--border);
		border-radius: 8px;
		padding: 0.35rem;
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		box-shadow: 0 2px 8px rgb(0 0 0 / 0.15);
		white-space: nowrap;
		z-index: 10;
	}

	.menu a {
		text-decoration: none;
		color: var(--foreground);
		font-size: 0.8rem;
		padding: 0.3rem 0.6rem;
		border-radius: 6px;
	}

	.menu a:hover {
		background: var(--muted);
		color: var(--primary);
	}
</style>
