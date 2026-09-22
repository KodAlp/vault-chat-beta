<script lang="ts">
	import { onMount } from 'svelte';
	import ImportObsidianDialog from '$lib/components/ImportObsidianDialog.svelte';
	import LinksImportDialog from '$lib/components/LinksImportDialog.svelte';
	import LibraryTree from '$lib/components/LibraryTree.svelte';
	import type { LibrarySettings } from '$lib/types';
	import { Switch } from '$lib/components/ui/switch';
	import { Input } from '$lib/components/ui/input';
	import * as Card from '$lib/components/ui/card';
	import { t } from '$lib/i18n/index.svelte';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';

	let settings = $state<LibrarySettings>({
		keepOriginals: false,
		allowedLanguages: ['Türkçe'],
		hiddenFolders: ['raw', 'cards', 'frontier', 'notes'],
		flattenFolders: ['wiki']
	});
	let allowedLanguagesInput = $state('Türkçe');
	let hiddenFoldersInput = $state('');
	let flattenFoldersInput = $state('');
	let loadError = $state('');

	onMount(async () => {
		try {
			const res = await fetch('/api/library/settings');
			if (!res.ok) throw new Error();
			settings = (await res.json()) as LibrarySettings;
			allowedLanguagesInput = settings.allowedLanguages.join(', ');
			hiddenFoldersInput = settings.hiddenFolders.join(', ');
			flattenFoldersInput = settings.flattenFolders.join(', ');
		} catch {
			loadError = t('LibrarySettingsPage.loadError');
		}
	});

	async function persist() {
		try {
			await fetch('/api/library/settings', {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(settings)
			});
		} catch {
			loadError = t('LibrarySettingsPage.saveError');
		}
	}

	function parseCsv(input: string): string[] {
		return input
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean);
	}

	function persistAllowedLanguages() {
		const parsed = parseCsv(allowedLanguagesInput);
		settings.allowedLanguages = parsed.length ? parsed : ['Türkçe'];
		void persist();
	}

	// Unlike allowedLanguages, these two CAN be legitimately emptied (a vault
	// with no bookkeeping folders to hide, or one where flattening wiki/
	// isn't wanted) — no non-empty fallback.
	function persistHiddenFolders() {
		settings.hiddenFolders = parseCsv(hiddenFoldersInput);
		void persist();
	}

	function persistFlattenFolders() {
		settings.flattenFolders = parseCsv(flattenFoldersInput);
		void persist();
	}
</script>

<svelte:head>
	<title>{t('LibrarySettingsPage.title')} — Vault Agent Toolkit</title>
</svelte:head>

<div class="mx-auto max-w-2xl px-4 pt-6 pb-12">
	<div class="mb-6 flex items-baseline gap-4">
		<a href="/settings" class="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-[var(--accent)] focus-visible:outline-offset-2">
			<ArrowLeftIcon size={14} aria-hidden="true" /> {t('Common.ayarlar')}
		</a>
		<h1 class="font-display text-xl font-medium">{t('LibrarySettingsPage.title')}</h1>
	</div>

	{#if loadError}
		<p class="mb-4 text-sm text-destructive" role="alert">{loadError}</p>
	{/if}

	<Card.Root class="mb-6">
		<Card.Header>
			<Card.Title>{t('LibrarySettingsPage.importObsidianTitle')}</Card.Title>
			<Card.Description>
				{t('LibrarySettingsPage.importObsidianDescription')}
			</Card.Description>
		</Card.Header>
		<Card.Content>
			<ImportObsidianDialog />
		</Card.Content>
	</Card.Root>

	<Card.Root class="mb-6">
		<Card.Header>
			<Card.Title>{t('LibrarySettingsPage.importLinksTitle')}</Card.Title>
			<Card.Description>
				{t('LibrarySettingsPage.importLinksDescription')}
			</Card.Description>
		</Card.Header>
		<Card.Content>
			<LinksImportDialog />
		</Card.Content>
	</Card.Root>

	<Card.Root class="mb-6">
		<Card.Header>
			<Card.Title>{t('LibrarySettingsPage.uploadSettingsTitle')}</Card.Title>
		</Card.Header>
		<Card.Content class="flex flex-col gap-4">
			<label class="flex cursor-pointer items-center gap-2 text-sm">
				<Switch bind:checked={settings.keepOriginals} onCheckedChange={persist} />
				{t('LibrarySettingsPage.keepOriginals', { path: 'data/library/_meta/originals/' })}
			</label>
			<label class="flex flex-col gap-1 text-sm">
				{t('LibrarySettingsPage.allowedLanguages')}
				<Input
					type="text"
					bind:value={allowedLanguagesInput}
					onchange={persistAllowedLanguages}
					placeholder={t('LibrarySettingsPage.allowedLanguagesPlaceholder')}
				/>
				<span class="text-xs text-muted-foreground">
					{t('LibrarySettingsPage.allowedLanguagesHint')}
				</span>
			</label>
			<label class="flex flex-col gap-1 text-sm">
				{t('LibrarySettingsPage.hiddenFolders')}
				<Input
					type="text"
					bind:value={hiddenFoldersInput}
					onchange={persistHiddenFolders}
					placeholder={t('LibrarySettingsPage.hiddenFoldersPlaceholder')}
				/>
				<span class="text-xs text-muted-foreground">
					{t('LibrarySettingsPage.hiddenFoldersHint')}
				</span>
			</label>
			<label class="flex flex-col gap-1 text-sm">
				{t('LibrarySettingsPage.flattenFolders')}
				<Input
					type="text"
					bind:value={flattenFoldersInput}
					onchange={persistFlattenFolders}
					placeholder={t('LibrarySettingsPage.flattenFoldersPlaceholder')}
				/>
				<span class="text-xs text-muted-foreground">
					{t('LibrarySettingsPage.flattenFoldersHint')}
				</span>
			</label>
		</Card.Content>
	</Card.Root>

	<Card.Root>
		<Card.Header>
			<Card.Title>{t('LibrarySettingsPage.libraryTreeTitle')}</Card.Title>
			<Card.Description>
				{t('LibrarySettingsPage.libraryTreeDescription')}
			</Card.Description>
		</Card.Header>
		<Card.Content>
			<div class="library-tree-wrap">
				<LibraryTree />
			</div>
		</Card.Content>
	</Card.Root>
</div>

<style>
	.library-tree-wrap {
		max-height: 24rem;
		overflow-y: auto;
	}
</style>
