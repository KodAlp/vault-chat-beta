<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import { t } from '$lib/i18n/index.svelte';

	type Config =
		| { available: false }
		| { available: true; nodePath: string; launchPath: string; dataDir: string; json: string; claudeCodeCommand: string };

	type ClientId = 'claudeDesktop' | 'claudeCode' | 'lmStudio' | 'jan' | 'generic';
	const CLIENTS: { id: ClientId; label: string }[] = [
		{ id: 'claudeDesktop', label: 'Claude Desktop' },
		{ id: 'claudeCode', label: 'Claude Code' },
		{ id: 'lmStudio', label: 'LM Studio' },
		{ id: 'jan', label: 'Jan' },
		{ id: 'generic', label: 'JSON' }
	];

	// Known per-OS config file locations (only where the client documents a file).
	const CLAUDE_DESKTOP_FILES = [
		{ os: 'Windows', path: '%APPDATA%\Claude\claude_desktop_config.json' },
		{ os: 'macOS', path: '~/Library/Application Support/Claude/claude_desktop_config.json' },
		{ os: 'Linux', path: '~/.config/Claude/claude_desktop_config.json' }
	];

	let config = $state<Config | null>(null);
	let loadError = $state(false);
	let client = $state<ClientId>('claudeDesktop');
	let copiedKey = $state<string | null>(null);
	let copyTimer: ReturnType<typeof setTimeout> | undefined;

	onMount(async () => {
		try {
			const res = await fetch('/api/settings/mcp/client-config');
			if (!res.ok) throw new Error();
			config = (await res.json()) as Config;
		} catch {
			loadError = true;
		}
	});
	onDestroy(() => clearTimeout(copyTimer));

	async function copy(key: string, text: string) {
		try {
			await navigator.clipboard.writeText(text);
			copiedKey = key;
			clearTimeout(copyTimer);
			copyTimer = setTimeout(() => (copiedKey = null), 2000);
		} catch {
			copiedKey = null;
		}
	}
</script>

{#snippet snippetBlock(key: string, text: string)}
	<div class="relative">
		<pre tabindex="0" class="overflow-x-auto rounded-lg border bg-muted/40 p-3 pe-20 font-mono text-xs"><code>{text}</code></pre>
		<Button type="button" size="sm" variant="outline" class="absolute end-2 top-2" onclick={() => copy(key, text)}>
			{copiedKey === key ? t('McpConnect.copied') : t('McpConnect.copy')}
		</Button>
	</div>
{/snippet}

<Card.Root>
	<Card.Header>
		<Card.Title level={2}>{t('McpConnect.title')}</Card.Title>
		<Card.Description>{t('McpConnect.description')}</Card.Description>
	</Card.Header>
	<Card.Content class="flex flex-col gap-3">
		{#if loadError}
			<p class="text-sm text-destructive" role="alert">{t('McpConnect.loadFailed')}</p>
		{:else if config && !config.available}
			<p class="rounded-lg border px-3 py-2 text-sm text-muted-foreground" role="status">{t('McpConnect.notBundled')}</p>
		{:else if config && config.available}
			<div class="flex flex-wrap gap-1.5" role="group" aria-label={t('McpConnect.title')}>
				{#each CLIENTS as c (c.id)}
					<Button type="button" size="sm" variant={client === c.id ? 'default' : 'outline'} aria-pressed={client === c.id} onclick={() => (client = c.id)}>
						{c.label}
					</Button>
				{/each}
			</div>

			{#if client === 'claudeDesktop'}
				<p class="text-sm text-muted-foreground">{t('McpConnect.claudeDesktopSteps')}</p>
				<ul class="flex flex-col gap-1 text-xs">
					{#each CLAUDE_DESKTOP_FILES as f (f.os)}
						<li><span class="font-medium">{f.os}:</span> <code class="font-mono break-all">{f.path}</code></li>
					{/each}
				</ul>
				{@render snippetBlock('json', config.json)}
			{:else if client === 'claudeCode'}
				<p class="text-sm text-muted-foreground">{t('McpConnect.claudeCodeSteps')}</p>
				{@render snippetBlock('cmd', config.claudeCodeCommand)}
			{:else if client === 'lmStudio'}
				<p class="text-sm text-muted-foreground">{t('McpConnect.lmStudioSteps')}</p>
				{@render snippetBlock('json', config.json)}
			{:else if client === 'jan'}
				<p class="text-sm text-muted-foreground">{t('McpConnect.janSteps')}</p>
				{@render snippetBlock('json', config.json)}
			{:else}
				<p class="text-sm text-muted-foreground">{t('McpConnect.genericSteps')}</p>
				{@render snippetBlock('json', config.json)}
			{/if}

			<p class="text-xs text-muted-foreground">{t('McpConnect.secretsNote')}</p>
		{/if}
	</Card.Content>
</Card.Root>
