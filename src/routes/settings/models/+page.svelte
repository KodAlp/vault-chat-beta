<script lang="ts">
	import { onMount } from 'svelte';
	import { settings, persistSettings } from '$lib/settings.svelte';
	import type { OllamaModel, ProviderModelOption } from '$lib/types';
	import { selectionKey, parseSelectionKey } from '$lib/model-selection';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { Switch } from '$lib/components/ui/switch';
	import * as Select from '$lib/components/ui/select';
	import * as AlertDialog from '$lib/components/ui/alert-dialog';
	import { t } from '$lib/i18n/index.svelte';
	import { localizeError, readResponseError } from '$lib/server-error';
	import DownloadIcon from '@lucide/svelte/icons/download';
	import TrashIcon from '@lucide/svelte/icons/trash';

	// Stable per-instance id prefix for label/control association.
	const uid = $props.id();

	// Aşama 4d: the Ollama model manager (installed list / download / delete) only exists when an ENABLED
	// ollama-kind provider does — Ollama is an ordinary, optional provider now.
	let hasOllama = $state(false);
	async function refreshHasOllama() {
		try {
			const res = await fetch('/api/providers');
			if (res.ok) hasOllama = ((await res.json()) as { kind: string; enabled: boolean }[]).some((p) => p.kind === 'ollama' && p.enabled);
		} catch {
			hasOllama = false;
		}
	}

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
			if (!res.ok) {
				pullError = await readResponseError(res);
				pullStatus = '';
				return;
			}
			if (!res.body) {
				pullError = t('SettingsPage.pullFailed');
				pullStatus = '';
				return;
			}
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
					const event = JSON.parse(line.slice(5)) as {
						type: string;
						status?: string;
						error?: string;
						code?: string;
						params?: Record<string, string | number>;
					};
					if (event.type === 'progress') pullStatus = event.status ?? t('SettingsPage.downloading');
					else if (event.type === 'done') {
						pullStatus = t('SettingsPage.pullDone');
						pullName = '';
						await refreshModels();
					} else if (event.type === 'error') {
						pullError = localizeError({ code: event.code, params: event.params, message: event.error });
						pullStatus = '';
					}
				}
			}
		} catch {
			pullError = t('SettingsPage.pullFailed');
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

	onMount(async () => {
		await refreshHasOllama();
		await Promise.all([hasOllama ? refreshModels() : Promise.resolve(), refreshProviderModels()]);
	});
</script>

<svelte:head>
	<title>{t('SettingsNav.models')} — Vault Agent Toolkit</title>
</svelte:head>

<div class="flex flex-col gap-6">
	<p class="text-sm text-muted-foreground">{t('ModelsSettingsPage.intro')}</p>

	{#if loadError}
		<p class="text-sm text-destructive" role="alert">{loadError}</p>
	{/if}
	{#if providerModelsError}
		<p class="text-sm text-destructive" role="alert">{providerModelsError}</p>
	{/if}

	<section class="vc-group !p-0">
		<h2 class="vc-group-title">{t('ModelsSettingsPage.rolesTitle')}</h2>
		<div class="vc-list">
		<div class="vc-list-row py-3">
			<div class="flex min-w-0 flex-col gap-0.5">
				<Label for="{uid}-default-model">{t('SettingsPage.defaultModel')}</Label>
				<span class="text-xs text-muted-foreground">{t('SettingsPage.defaultModelHint')}</span>
			</div>
			<Select.Root
				type="single"
				value={selectionKey(settings.defaultProvider, settings.defaultModel)}
				onValueChange={(v) => setModelSelection('default', v)}
			>
				<Select.Trigger id="{uid}-default-model" class="ml-auto w-56 max-w-[50%]">{settings.defaultModel}</Select.Trigger>
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
		<div class="vc-list-row py-3">
			<div class="flex min-w-0 flex-col gap-0.5">
				<Label for="{uid}-fast-model">{t('SettingsPage.fastModel')}</Label>
				<span class="text-xs text-muted-foreground">{t('SettingsPage.fastModelHint')}</span>
			</div>
			<Select.Root
				type="single"
				value={selectionKey(settings.fastProvider, settings.fastModel)}
				onValueChange={(v) => setModelSelection('fast', v)}
			>
				<Select.Trigger id="{uid}-fast-model" class="ml-auto w-56 max-w-[50%]">{settings.fastModel}</Select.Trigger>
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
		<div class="vc-list-row py-3">
			<div class="flex min-w-0 flex-col gap-0.5">
				<Label for="{uid}-reasoning-model">{t('SettingsPage.reasoningModel')}</Label>
				<span class="text-xs text-muted-foreground">{t('SettingsPage.reasoningModelHint')}</span>
			</div>
			<Select.Root
				type="single"
				value={selectionKey(settings.reasoningProvider, settings.reasoningModel)}
				onValueChange={(v) => setModelSelection('reasoning', v)}
			>
				<Select.Trigger id="{uid}-reasoning-model" class="ml-auto w-56 max-w-[50%]">{settings.reasoningModel}</Select.Trigger>
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
		</div>
	</section>

	{#if hasOllama}
		<section class="vc-group !p-0">
			<h2 class="vc-group-title">{t('ModelsSettingsPage.ollamaTitle')}</h2>
			<div class="vc-list">
				<div class="vc-list-row py-3">
					<div class="flex min-w-0 flex-col gap-0.5">
						<Label>{t('SettingsPage.installedModels')}</Label>
						<span class="text-xs text-muted-foreground">{t('SettingsPage.installedModelsHint')}</span>
					</div>
				</div>
				{#if models.length === 0}
					<div class="vc-list-row"><span class="text-sm text-muted-foreground">{t('SettingsPage.noInstalledModels')}</span></div>
				{:else}
					{#each models as m (m.name)}
						<div class="vc-list-row">
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
						</div>
					{/each}
				{/if}
				<div class="vc-list-row flex-col items-stretch justify-center gap-1.5 py-3">
					<Label for="{uid}-pull-model">{t('SettingsPage.pullModelLabel')}</Label>
					<span class="text-xs text-muted-foreground">{t('SettingsPage.pullModelHint')}</span>
					<div class="flex gap-2">
						<Input
							id="{uid}-pull-model"
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
			</div>
		</section>
	{/if}

	<section class="vc-group !p-0">
		<h2 class="vc-group-title">{t('SettingsPage.generationTitle')}</h2>
		<div class="vc-list">
			<label class="vc-list-row cursor-pointer items-start py-3">
				<span class="flex min-w-0 flex-1 flex-col gap-0.5 text-sm">
					{t('SettingsPage.allowConcurrentGeneration')}
					<span class="text-xs text-muted-foreground">
						{t('SettingsPage.allowConcurrentGenerationHint')}
					</span>
				</span>
				<Switch bind:checked={settings.allowConcurrentGeneration} onCheckedChange={persistSettings} />
			</label>
		</div>
	</section>
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
