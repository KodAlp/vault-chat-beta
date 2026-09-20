<script lang="ts">
	import { onMount } from 'svelte';
	import { settings, persistSettings } from '$lib/settings.svelte';
	import { i18n, persistLocale, type Locale } from '$lib/i18n/index.svelte';
	import type { OllamaModel, ProviderModelOption, VaultRecord } from '$lib/types';
	import { selectionKey, parseSelectionKey } from '$lib/model-selection';
	import { isTauri, invoke } from '@tauri-apps/api/core';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { Switch } from '$lib/components/ui/switch';
	import * as Select from '$lib/components/ui/select';
	import * as Card from '$lib/components/ui/card';
	import * as AlertDialog from '$lib/components/ui/alert-dialog';
	import { Separator } from '$lib/components/ui/separator';
	import { t } from '$lib/i18n/index.svelte';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import ArrowRightIcon from '@lucide/svelte/icons/arrow-right';
	import DownloadIcon from '@lucide/svelte/icons/download';
	import TrashIcon from '@lucide/svelte/icons/trash';

	let models = $state<OllamaModel[]>([]);
	let loadError = $state('');
	let pullName = $state('');
	let pulling = $state(false);
	let pullStatus = $state('');
	let pullError = $state('');
	let deleteTarget = $state<OllamaModel | null>(null);
	let deleting = $state(false);
	let deleteError = $state('');

	async function refreshModels() {
		try {
			const res = await fetch('/api/models');
			if (!res.ok) throw new Error();
			models = (await res.json()) as OllamaModel[];
		} catch {
			loadError = t('SettingsPage.modelListError');
		}
	}

	/**
	 * Faz 17 — providerId end-to-end. The three model selectors below used
	 * to read /api/models (Ollama-only), so a model added under a newly
	 * connected cloud provider (an API key saved on /settings/providers)
	 * never showed up here at all — there was nowhere to actually pick it.
	 * /api/providers/models aggregates every ENABLED provider (Ollama
	 * included) and already tags each option with providerId/providerLabel,
	 * so this reuses it instead of inventing a second listing endpoint.
	 */
	let providerModels = $state<ProviderModelOption[]>([]);
	let providerModelsError = $state('');

	async function refreshProviderModels() {
		try {
			const res = await fetch('/api/providers/models');
			if (!res.ok) throw new Error();
			providerModels = (await res.json()) as ProviderModelOption[];
		} catch {
			providerModelsError = t('SettingsPage.providerModelsError');
		}
	}

	interface ProviderModelGroup {
		providerId: string;
		providerLabel: string;
		models: ProviderModelOption[];
	}

	function groupByProvider(options: ProviderModelOption[]): ProviderModelGroup[] {
		const groups = new Map<string, ProviderModelGroup>();
		for (const opt of options) {
			let group = groups.get(opt.providerId);
			if (!group) {
				group = { providerId: opt.providerId, providerLabel: opt.providerLabel, models: [] };
				groups.set(opt.providerId, group);
			}
			group.models.push(opt);
		}
		return [...groups.values()];
	}

	let groupedModels = $derived(groupByProvider(providerModels));

	function setModelSelection(kind: 'default' | 'fast' | 'reasoning', key: string) {
		const { providerId, modelId } = parseSelectionKey(key);
		if (kind === 'default') {
			settings.defaultModel = modelId;
			settings.defaultProvider = providerId;
		} else if (kind === 'fast') {
			settings.fastModel = modelId;
			settings.fastProvider = providerId;
		} else {
			settings.reasoningModel = modelId;
			settings.reasoningProvider = providerId;
		}
		persistSettings();
	}

	async function pullModel() {
		const name = pullName.trim();
		if (!name || pulling) return;
		pulling = true;
		pullStatus = t('SettingsPage.pullStarting');
		pullError = '';
		try {
			const res = await fetch('/api/models', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ model: name })
			});
			if (!res.ok || !res.body) throw new Error(t('SettingsPage.requestFailed', { status: res.status }));
			const reader = res.body.getReader();
			const decoder = new TextDecoder();
			let buffer = '';
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				const parts = buffer.split('\n\n');
				buffer = parts.pop() ?? '';
				for (const part of parts) {
					const line = part.trim();
					if (!line.startsWith('data:')) continue;
					const event = JSON.parse(line.slice(5)) as { type: string; status?: string; error?: string };
					if (event.type === 'progress') pullStatus = event.status ?? t('SettingsPage.downloading');
					else if (event.type === 'done') {
						pullStatus = t('SettingsPage.pullDone');
						pullName = '';
						await refreshModels();
					} else if (event.type === 'error') {
						pullError = event.error ?? t('SettingsPage.pullFailed');
						pullStatus = '';
					}
				}
			}
		} catch (err) {
			pullError = err instanceof Error ? err.message : t('SettingsPage.pullFailed');
			pullStatus = '';
		} finally {
			pulling = false;
		}
	}

	async function confirmDelete() {
		const m = deleteTarget;
		if (!m || deleting) return;
		deleteTarget = null;
		deleting = true;
		deleteError = '';
		try {
			const res = await fetch('/api/models', {
				method: 'DELETE',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ model: m.name })
			});
			if (!res.ok) throw new Error();
			await refreshModels();
		} catch {
			deleteError = t('SettingsPage.deleteModelFailed', { name: m.name });
		} finally {
			deleting = false;
		}
	}

	const runningInTauri = isTauri();
	let vaultPath = $state('');
	let vaultName = $state('');
	let vaultSaveStatus = $state<'idle' | 'saved' | 'error'>('idle');

	/**
	 * The vault actually being browsed right now (data/vaults.json's
	 * registry, via markVaultUsed() — see vaults.ts — called whenever
	 * /vault/[id] or one of its chats is opened), as opposed to
	 * vaultPath/vaultName above, which are the Tauri desktop build's
	 * separate first-run config.json (what the app launches into NEXT
	 * time, not what it's showing now — see that card's own "bir sonraki
	 * uygulama başlatmasında etkili olur" copy). Those two can point at
	 * completely different vaults once more than one exists — this is
	 * what fixes settings always appearing to show one fixed vault's
	 * location regardless of which vault is actually open.
	 */
	let activeVault = $state<VaultRecord | null>(null);

	async function refreshActiveVault() {
		try {
			const res = await fetch('/api/vaults');
			if (!res.ok) throw new Error();
			const data = (await res.json()) as { vaults: VaultRecord[]; activeVaultId: string | null };
			activeVault = data.vaults.find((v) => v.id === data.activeVaultId) ?? null;
		} catch {
			// The "Vault'ları yönet" link still works without this — the card
			// just shows no active-vault line.
		}
	}

	onMount(async () => {
		await Promise.all([refreshModels(), refreshProviderModels(), refreshActiveVault()]);

		if (runningInTauri) {
			try {
				const cfg = await invoke<{ vault_path: string; vault_name: string } | null>(
					'get_vault_config'
				);
				if (cfg) {
					vaultPath = cfg.vault_path;
					vaultName = cfg.vault_name;
				}
			} catch {
				// Settings page still usable without this — just starts blank.
			}
		}
	});

	async function pickVaultFolder() {
		const { open } = await import('@tauri-apps/plugin-dialog');
		const picked = await open({ directory: true, multiple: false });
		if (typeof picked === 'string') vaultPath = picked;
	}

	async function saveVaultConfig() {
		vaultSaveStatus = 'idle';
		try {
			await invoke('update_vault_config', { vaultPath, vaultName });
			vaultSaveStatus = 'saved';
		} catch {
			vaultSaveStatus = 'error';
		}
	}

	let themeOptions = $derived([
		{ value: 'system', label: t('SettingsPage.themeSystem') },
		{ value: 'light', label: t('SettingsPage.themeLight') },
		{ value: 'dark', label: t('SettingsPage.themeDark') }
	] as const);

	// Locale names are endonyms (a language's own name for itself) — these
	// stay as-is regardless of UI locale, same as "Français" doesn't become
	// "French" in an English menu.
	const localeOptions: { value: Locale; label: string }[] = [
		{ value: 'tr', label: 'Türkçe' },
		{ value: 'en', label: 'English' }
	];
</script>

<svelte:head>
	<title>{t('Common.ayarlar')} — Vault Agent Toolkit</title>
</svelte:head>

<div class="mx-auto max-w-2xl px-4 pt-6 pb-12">
	<div class="mb-8 flex items-baseline gap-4">
		<a href="/" class="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-[var(--accent)] focus-visible:outline-offset-2">
			<ArrowLeftIcon size={14} aria-hidden="true" /> {t('SettingsPage.home')}
		</a>
		<h1 class="font-display text-xl font-medium">{t('Common.ayarlar')}</h1>
	</div>

	<Card.Root class="mb-6">
		<Card.Header>
			<Card.Title>{t('SettingsPage.themeTitle')}</Card.Title>
		</Card.Header>
		<Card.Content class="flex gap-5">
			{#each themeOptions as opt (opt.value)}
				<label class="flex cursor-pointer items-center gap-1.5 text-sm">
					<input
						type="radio"
						name="theme"
						value={opt.value}
						bind:group={settings.theme}
						onchange={persistSettings}
						class="accent-primary"
					/>
					{opt.label}
				</label>
			{/each}
		</Card.Content>
	</Card.Root>

	<Card.Root class="mb-6">
		<Card.Header>
			<Card.Title>{t('SettingsPage.languageTitle')}</Card.Title>
		</Card.Header>
		<Card.Content class="flex gap-5">
			{#each localeOptions as opt (opt.value)}
				<label class="flex cursor-pointer items-center gap-1.5 text-sm">
					<input
						type="radio"
						name="locale"
						value={opt.value}
						bind:group={i18n.locale}
						onchange={persistLocale}
						class="accent-primary"
					/>
					{opt.label}
				</label>
			{/each}
		</Card.Content>
	</Card.Root>

	<Card.Root class="mb-6">
		<Card.Header>
			<Card.Title>{t('SettingsPage.modelsTitle')}</Card.Title>
		</Card.Header>
		<Card.Content class="flex flex-col gap-4">
			{#if loadError}
				<p class="text-sm text-destructive" role="alert">{loadError}</p>
			{/if}
			{#if providerModelsError}
				<p class="text-sm text-destructive" role="alert">{providerModelsError}</p>
			{/if}

			<div class="flex flex-col gap-1.5">
				<Label>{t('SettingsPage.defaultModel')}</Label>
				<span class="text-xs text-muted-foreground">{t('SettingsPage.defaultModelHint')}</span>
				<Select.Root
					type="single"
					value={selectionKey(settings.defaultProvider, settings.defaultModel)}
					onValueChange={(v) => setModelSelection('default', v)}
				>
					<Select.Trigger class="max-w-xs">{settings.defaultModel}</Select.Trigger>
					<Select.Content>
						{#each groupedModels as group (group.providerId)}
							<Select.Group>
								<Select.GroupHeading>{group.providerLabel}</Select.GroupHeading>
								{#each group.models as m (m.id)}
									<Select.Item value={selectionKey(group.providerId, m.id)} label={m.id}>{m.id}</Select.Item>
								{/each}
							</Select.Group>
						{/each}
					</Select.Content>
				</Select.Root>
			</div>

			<div class="flex flex-col gap-1.5">
				<Label>{t('SettingsPage.fastModel')}</Label>
				<span class="text-xs text-muted-foreground">{t('SettingsPage.fastModelHint')}</span>
				<Select.Root
					type="single"
					value={selectionKey(settings.fastProvider, settings.fastModel)}
					onValueChange={(v) => setModelSelection('fast', v)}
				>
					<Select.Trigger class="max-w-xs">{settings.fastModel}</Select.Trigger>
					<Select.Content>
						{#each groupedModels as group (group.providerId)}
							<Select.Group>
								<Select.GroupHeading>{group.providerLabel}</Select.GroupHeading>
								{#each group.models as m (m.id)}
									<Select.Item value={selectionKey(group.providerId, m.id)} label={m.id}>{m.id}</Select.Item>
								{/each}
							</Select.Group>
						{/each}
					</Select.Content>
				</Select.Root>
			</div>

			<div class="flex flex-col gap-1.5">
				<Label>{t('SettingsPage.reasoningModel')}</Label>
				<span class="text-xs text-muted-foreground">{t('SettingsPage.reasoningModelHint')}</span>
				<Select.Root
					type="single"
					value={selectionKey(settings.reasoningProvider, settings.reasoningModel)}
					onValueChange={(v) => setModelSelection('reasoning', v)}
				>
					<Select.Trigger class="max-w-xs">{settings.reasoningModel}</Select.Trigger>
					<Select.Content>
						{#each groupedModels as group (group.providerId)}
							<Select.Group>
								<Select.GroupHeading>{group.providerLabel}</Select.GroupHeading>
								{#each group.models as m (m.id)}
									<Select.Item value={selectionKey(group.providerId, m.id)} label={m.id}>{m.id}</Select.Item>
								{/each}
							</Select.Group>
						{/each}
					</Select.Content>
				</Select.Root>
			</div>

			<Separator class="my-1" />

			<div class="flex flex-col gap-1.5">
				<Label>{t('SettingsPage.installedModels')}</Label>
				<span class="text-xs text-muted-foreground">{t('SettingsPage.installedModelsHint')}</span>
				{#if models.length === 0}
					<p class="text-sm text-muted-foreground">{t('SettingsPage.noInstalledModels')}</p>
				{:else}
					<ul class="flex flex-col gap-1">
						{#each models as m (m.name)}
							<li class="flex items-center justify-between gap-2 rounded-md border px-2.5 py-1.5 text-sm">
								<span class="min-w-0 flex-1 truncate font-mono text-xs">{m.name}</span>
								<span class="shrink-0 text-xs text-muted-foreground">{(m.size / 1e9).toFixed(1)} GB</span>
								<Button
									type="button"
									variant="ghost"
									size="sm"
									class="h-7 px-2 text-destructive hover:text-destructive"
									title={t('SettingsPage.deleteModel')}
									aria-label={t('SettingsPage.deleteModelAria', { name: m.name })}
									onclick={() => (deleteTarget = m)}
								>
									<TrashIcon size={14} aria-hidden="true" />
								</Button>
							</li>
						{/each}
					</ul>
				{/if}
			</div>

			<div class="flex flex-col gap-1.5">
				<Label>{t('SettingsPage.pullModelLabel')}</Label>
				<span class="text-xs text-muted-foreground">{t('SettingsPage.pullModelHint')}</span>
				<div class="flex gap-2">
					<Input
						type="text"
						bind:value={pullName}
						placeholder={t('SettingsPage.modelNamePlaceholder')}
						class="max-w-xs"
						disabled={pulling}
						onkeydown={(e) => e.key === 'Enter' && pullModel()}
					/>
					<Button type="button" onclick={pullModel} disabled={!pullName.trim()} loading={pulling}>
						{#if !pulling}<DownloadIcon size={14} aria-hidden="true" />{/if} {pulling ? t('SettingsPage.downloading') : t('SettingsPage.downloadModel')}
					</Button>
				</div>
				{#if pullStatus}
					<p class="text-xs text-muted-foreground">{pullStatus}</p>
				{/if}
				{#if pullError}
					<p class="text-xs text-destructive" role="alert">{pullError}</p>
				{/if}
				{#if deleteError}
					<p class="text-xs text-destructive" role="alert">{deleteError}</p>
				{/if}
			</div>
		</Card.Content>
	</Card.Root>

	<Card.Root class="mb-6">
		<Card.Header>
			<Card.Title>{t('SettingsPage.generationTitle')}</Card.Title>
		</Card.Header>
		<Card.Content>
			<label class="flex cursor-pointer items-start gap-2.5 text-sm">
				<Switch bind:checked={settings.allowConcurrentGeneration} onCheckedChange={persistSettings} />
				<span class="flex flex-col gap-0.5">
					{t('SettingsPage.allowConcurrentGeneration')}
					<span class="text-xs text-muted-foreground">
						{t('SettingsPage.allowConcurrentGenerationHint')}
					</span>
				</span>
			</label>
		</Card.Content>
	</Card.Root>

	<Card.Root class="mb-6">
		<Card.Header>
			<Card.Title>{t('SettingsPage.welcomeScreenTitle')}</Card.Title>
		</Card.Header>
		<Card.Content>
			<label class="flex cursor-pointer items-start gap-2.5 text-sm">
				<Switch bind:checked={settings.showWelcomeScreen} onCheckedChange={persistSettings} />
				<span class="flex flex-col gap-0.5">
					{t('SettingsPage.showWelcomeScreen')}
					<span class="text-xs text-muted-foreground">
						{t('SettingsPage.showWelcomeScreenHint')}
					</span>
				</span>
			</label>
		</Card.Content>
	</Card.Root>

	{#if runningInTauri}
		<Card.Root class="mb-6">
			<Card.Header>
				<Card.Title>{t('SettingsPage.desktopVaultTitle')}</Card.Title>
				<Card.Description>
					{t('SettingsPage.desktopVaultDescription')}
				</Card.Description>
			</Card.Header>
			<Card.Content class="flex flex-col gap-4">
				<div class="flex flex-col gap-1.5">
					<Label>{t('SettingsPage.vaultFolder')}</Label>
					<div class="flex gap-2">
						<Input type="text" readonly value={vaultPath} placeholder={t('SettingsPage.vaultFolderPlaceholder')} class="flex-1" />
						<Button type="button" variant="outline" onclick={pickVaultFolder}>{t('SettingsPage.choose')}</Button>
					</div>
				</div>
				<div class="flex flex-col gap-1.5">
					<Label>{t('SettingsPage.obsidianVaultName')}</Label>
					<Input type="text" bind:value={vaultName} class="max-w-xs" />
				</div>
				<div>
					<Button type="button" onclick={saveVaultConfig}>{t('Common.kaydet')}</Button>
					{#if vaultSaveStatus === 'saved'}
						<span class="ml-2 text-sm text-[var(--success)]">{t('SettingsPage.vaultSaved')}</span>
					{:else if vaultSaveStatus === 'error'}
						<span class="ml-2 text-sm text-destructive" role="alert">{t('SettingsPage.vaultSaveFailed')}</span>
					{/if}
				</div>
			</Card.Content>
		</Card.Root>
	{/if}

	<Card.Root class="mb-6">
		<Card.Header>
			<Card.Title>{t('VaultsSettingsPage.title')}</Card.Title>
			<Card.Description>{t('SettingsPage.vaultsCardDescription')}</Card.Description>
		</Card.Header>
		<Card.Content class="flex flex-col gap-3">
			{#if activeVault}
				<div class="flex flex-col gap-1 text-sm">
					<span class="text-muted-foreground">{t('SettingsPage.activeVaultLabel')}</span>
					<span class="font-semibold">{activeVault.name}</span>
					<span class="font-mono text-xs break-all text-muted-foreground">{activeVault.path}</span>
				</div>
			{/if}
			<a href="/settings/vaults" class="flex items-center gap-1 text-sm font-semibold text-primary hover:underline">
				{t('SettingsPage.manageVaults')} <ArrowRightIcon size={14} aria-hidden="true" />
			</a>
		</Card.Content>
	</Card.Root>

	<Card.Root class="mb-6">
		<Card.Header>
			<Card.Title>{t('LibrarySettingsPage.title')}</Card.Title>
			<Card.Description>{t('SettingsPage.libraryCardDescription')}</Card.Description>
		</Card.Header>
		<Card.Content>
			<a href="/settings/library" class="flex items-center gap-1 text-sm font-semibold text-primary hover:underline">
				{t('SettingsPage.manageLibrary')} <ArrowRightIcon size={14} aria-hidden="true" />
			</a>
		</Card.Content>
	</Card.Root>

	<Card.Root class="mb-6">
		<Card.Header>
			<Card.Title>{t('SkillsSettingsPage.title')}</Card.Title>
			<Card.Description>{t('SettingsPage.skillsCardDescription')}</Card.Description>
		</Card.Header>
		<Card.Content>
			<a href="/settings/skills" class="flex items-center gap-1 text-sm font-semibold text-primary hover:underline">
				{t('SettingsPage.manageSkills')} <ArrowRightIcon size={14} aria-hidden="true" />
			</a>
		</Card.Content>
	</Card.Root>

	<Card.Root>
		<Card.Header>
			<Card.Title>{t('ProvidersSettingsPage.title')}</Card.Title>
			<Card.Description>{t('SettingsPage.providersCardDescription')}</Card.Description>
		</Card.Header>
		<Card.Content>
			<a href="/settings/providers" class="flex items-center gap-1 text-sm font-semibold text-primary hover:underline">
				{t('SettingsPage.manageProviders')} <ArrowRightIcon size={14} aria-hidden="true" />
			</a>
		</Card.Content>
	</Card.Root>
</div>

<AlertDialog.Root open={!!deleteTarget} onOpenChange={(open) => !open && (deleteTarget = null)}>
	<AlertDialog.Content>
		{#if deleteTarget}
			<AlertDialog.Header>
				<AlertDialog.Title>{t('SettingsPage.deleteModelConfirmTitle', { name: deleteTarget.name })}</AlertDialog.Title>
				<AlertDialog.Description>
					{t('SettingsPage.deleteModelConfirmDescription')}
				</AlertDialog.Description>
			</AlertDialog.Header>
			<AlertDialog.Footer>
				<AlertDialog.Cancel>{t('Common.vazgec')}</AlertDialog.Cancel>
				<AlertDialog.Action
					variant="destructive"
					onclick={(e) => {
						e.preventDefault();
						confirmDelete();
					}}
				>
					{t('Common.sil')}
				</AlertDialog.Action>
			</AlertDialog.Footer>
		{/if}
	</AlertDialog.Content>
</AlertDialog.Root>
