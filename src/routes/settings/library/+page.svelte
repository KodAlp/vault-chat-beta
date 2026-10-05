<script lang="ts">
	import { onMount } from 'svelte';
	import LinksImportDialog from '$lib/components/LinksImportDialog.svelte';
	import LibraryTree from '$lib/components/LibraryTree.svelte';
	import type { LibrarySettings } from '$lib/types';
	import { Switch } from '$lib/components/ui/switch';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import * as Card from '$lib/components/ui/card';
	import { t } from '$lib/i18n/index.svelte';

	let settings = $state<LibrarySettings>({
		keepOriginals: false,
		allowedLanguages: ['Türkçe'],
		responseLanguage: 'match',
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

	/**
	 * `previous` is a snapshot of `settings` taken by the caller BEFORE its
	 * own optimistic mutation — restored here on failure (network error or a
	 * non-2xx response, neither of which this used to check) so the UI never
	 * keeps showing an edit that the server never actually saved. The three
	 * CSV text inputs are resynced too, or they'd keep echoing the failed
	 * edit even after `settings` itself rolled back.
	 */
	async function persist(previous: LibrarySettings) {
		try {
			const res = await fetch('/api/library/settings', {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(settings)
			});
			if (!res.ok) throw new Error();
		} catch {
			settings = previous;
			allowedLanguagesInput = settings.allowedLanguages.join(', ');
			hiddenFoldersInput = settings.hiddenFolders.join(', ');
			flattenFoldersInput = settings.flattenFolders.join(', ');
			loadError = t('LibrarySettingsPage.saveError');
		}
	}

	function persistKeepOriginals(checked: boolean) {
		const previous = $state.snapshot(settings) as LibrarySettings;
		settings.keepOriginals = checked;
		void persist(previous);
	}

	/** `checked` true means "fixed" (always the primary language) — the Switch's own on/off
	 * reads naturally as "always" when on, "match the question" when off. */
	function persistResponseLanguage(checked: boolean) {
		const previous = $state.snapshot(settings) as LibrarySettings;
		settings.responseLanguage = checked ? 'fixed' : 'match';
		void persist(previous);
	}

	function parseCsv(input: string): string[] {
		return input
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean);
	}

	function persistAllowedLanguages() {
		const previous = $state.snapshot(settings) as LibrarySettings;
		const parsed = parseCsv(allowedLanguagesInput);
		settings.allowedLanguages = parsed.length ? parsed : ['Türkçe'];
		void persist(previous);
	}

	// Unlike allowedLanguages, these two CAN be legitimately emptied (a vault
	// with no bookkeeping folders to hide, or one where flattening wiki/
	// isn't wanted) — no non-empty fallback.
	function persistHiddenFolders() {
		const previous = $state.snapshot(settings) as LibrarySettings;
		settings.hiddenFolders = parseCsv(hiddenFoldersInput);
		void persist(previous);
	}

	function persistFlattenFolders() {
		const previous = $state.snapshot(settings) as LibrarySettings;
		settings.flattenFolders = parseCsv(flattenFoldersInput);
		void persist(previous);
	}
</script>

<svelte:head>
	<title>{t('LibrarySettingsPage.title')} — Vault Chat</title>
</svelte:head>

<div>
	{#if loadError}
		<p class="mb-4 text-sm text-destructive" role="alert">{loadError}</p>
	{/if}

	<Card.Root class="mb-6">
		<Card.Header>
			<Card.Title level={2}>{t('LibrarySettingsPage.importNotesTitle')}</Card.Title>
			<Card.Description>
				{t('LibrarySettingsPage.importNotesDescription')}
			</Card.Description>
		</Card.Header>
		<Card.Content>
			<Button variant="outline" href="/settings/import">{t('LibrarySettingsPage.importNotesOpen')}</Button>
		</Card.Content>
	</Card.Root>

	<Card.Root class="mb-6">
		<Card.Header>
			<Card.Title level={2}>{t('LibrarySettingsPage.importLinksTitle')}</Card.Title>
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
			<Card.Title level={2}>{t('LibrarySettingsPage.uploadSettingsTitle')}</Card.Title>
		</Card.Header>
		<Card.Content class="flex flex-col gap-4">
			<label class="flex cursor-pointer items-center gap-2 text-sm">
				<Switch checked={settings.keepOriginals} onCheckedChange={persistKeepOriginals} />
				{t('LibrarySettingsPage.keepOriginals', { path: 'data/library/_meta/originals/' })}
			</label>
			<div class="flex flex-col gap-1 text-sm">
				{t('LibrarySettingsPage.responseLanguage')}
				<label class="flex cursor-pointer items-center gap-2">
					<Switch checked={settings.responseLanguage === 'fixed'} onCheckedChange={persistResponseLanguage} />
					{settings.responseLanguage === 'fixed'
						? t('LibrarySettingsPage.responseLanguageFixed')
						: t('LibrarySettingsPage.responseLanguageMatch')}
				</label>
				<span class="text-xs text-muted-foreground">
					{t('LibrarySettingsPage.responseLanguageHint')}
				</span>
			</div>
			<details class="vc-disclosure">
				<summary>{t('LibrarySettingsPage.advancedUploadOptions')}</summary>
				<div class="body flex flex-col gap-4">
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
				</div>
			</details>
		</Card.Content>
	</Card.Root>

	<Card.Root>
		<Card.Header>
			<Card.Title level={2}>{t('LibrarySettingsPage.libraryTreeTitle')}</Card.Title>
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
