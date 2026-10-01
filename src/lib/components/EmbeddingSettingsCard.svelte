<script lang="ts">
	import { onMount } from 'svelte';
	import type { ProviderStatus, EmbeddingConfig } from '$lib/types';
	import * as Card from '$lib/components/ui/card';
	import * as Select from '$lib/components/ui/select';
	import * as AlertDialog from '$lib/components/ui/alert-dialog';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import ReindexDialog from './ReindexDialog.svelte';
	import { t } from '$lib/i18n/index.svelte';
	import { localizeError } from '$lib/server-error';

	/**
	 * Aşama 3c — "Embedding modeli" card. Lives on the providers settings
	 * page (not a page of its own, and not the vaults page) because it picks
	 * FROM the same provider list that page already manages: the provider
	 * select below is exactly "enabled ollama/openai-compat providers",
	 * i.e. a filtered view of the list the rest of this page renders, and
	 * the cloud-consent flow it triggers (POST /api/providers/[id]/consent)
	 * is the identical one that page's own model pickers already use. The
	 * vaults page (per-vault embeddingMismatch badge + reindex action) is
	 * downstream of THIS config, not where it's set.
	 *
	 * `providers` is a prop, not a separate fetch, so this stays in sync
	 * with the parent page's own refresh() (e.g. right after granting
	 * cloud consent) without a second round trip.
	 */
	let { providers }: { providers: ProviderStatus[] } = $props();

	const uid = $props.id();

	let embeddingCapable = $derived(providers.filter((p) => p.enabled && (p.kind === 'ollama' || p.kind === 'openai-compat')));

	// config === null after loading means FTS-only mode (no embedding configured, Aşama 4a) — `loaded`
	// is what distinguishes that from "still fetching".
	let config = $state<EmbeddingConfig | null>(null);
	let loaded = $state(false);
	let loadError = $state('');
	let saveError = $state('');
	let saving = $state(false);
	let saved = $state(false);
	let activeVaultId = $state<string | null>(null);

	let draftProviderId = $state('');
	let draftModel = $state('');
	let draftDims = $state<number | null>(null);
	let draftThreshold = $state<string | number | null>('');

	let ollamaModels = $state<{ name: string }[]>([]);

	let selectedProvider = $derived(providers.find((p) => p.id === draftProviderId));
	// isCloudSelected mirrors config-store.ts's isCloud(): ProviderStatus.local
	// already folds "kind === 'ollama'" and "openai-compat marked local" into
	// one boolean server-side (see /api/providers's mapToStatus), so this is
	// just its negation, not a re-derivation of the rule.
	let isCloudSelected = $derived(!!selectedProvider && !selectedProvider.local);
	let modelIsCalibrated = $derived(draftModel.trim().toLowerCase() === 'bge-m3');

	async function readErrorBody(res: Response): Promise<{ code?: string; text: string }> {
		let body: { code?: string; message?: string; params?: Record<string, string | number> } | null = null;
		try {
			body = await res.json();
		} catch {
			// non-JSON body — text below falls back to the generic status message
		}
		return {
			code: body?.code,
			text: body
				? localizeError({ code: body.code, params: body.params, message: body.message })
				: t('Common.istekBasarisiz', { status: String(res.status) })
		};
	}

	async function load() {
		try {
			const res = await fetch('/api/embedding');
			if (!res.ok) throw new Error();
			config = (await res.json()) as EmbeddingConfig | null;
			if (config) {
				draftProviderId = config.providerId;
				draftModel = config.model;
				draftDims = config.dims;
				draftThreshold = config.distanceThreshold !== undefined ? String(config.distanceThreshold) : '';
			}
			loaded = true;
		} catch {
			loadError = t('EmbeddingSettingsCard.loadError');
		}
	}

	async function loadOllamaModels() {
		try {
			const res = await fetch('/api/models');
			if (res.ok) ollamaModels = (await res.json()) as { name: string }[];
		} catch {
			// The model field just falls back to free text for ollama too.
		}
	}

	async function loadActiveVault() {
		try {
			const res = await fetch('/api/vaults');
			if (!res.ok) return;
			const data = (await res.json()) as { activeVaultId: string | null };
			activeVaultId = data.activeVaultId;
		} catch {
			// The "reindex now" offer just doesn't show a target — save() itself
			// already succeeded regardless.
		}
	}

	onMount(() => {
		void load();
		void loadOllamaModels();
		void loadActiveVault();
	});

	// İ2-style cloud consent gate, same shape as ModelPickerRow.svelte /
	// GenerationDialog.svelte's own pendingModel dialogs — reused here for
	// PUT /api/embedding and POST /api/embedding/test, both of which can come
	// back EMBEDDING_CONSENT_REQUIRED for a cloud provider with no prior
	// "remember my choice".
	let pendingConsentProviderId = $state<string | null>(null);
	let pendingConsentAction = $state<'save' | 'test' | null>(null);
	let consentBusy = $state(false);

	async function confirmConsent() {
		const providerId = pendingConsentProviderId;
		const action = pendingConsentAction;
		if (!providerId) return;
		consentBusy = true;
		try {
			await fetch(`/api/providers/${encodeURIComponent(providerId)}/consent`, { method: 'POST' });
			pendingConsentProviderId = null;
			pendingConsentAction = null;
			if (action === 'save') await save();
			else if (action === 'test') await testDims();
		} finally {
			consentBusy = false;
		}
	}

	let testing = $state(false);
	let testError = $state('');

	async function testDims() {
		if (!draftProviderId || !draftModel.trim()) return;
		testing = true;
		testError = '';
		try {
			const res = await fetch('/api/embedding/test', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ providerId: draftProviderId, model: draftModel.trim() })
			});
			if (!res.ok) {
				const { code, text } = await readErrorBody(res);
				if (code === 'EMBEDDING_CONSENT_REQUIRED') {
					pendingConsentProviderId = draftProviderId;
					pendingConsentAction = 'test';
					return;
				}
				testError = text;
				return;
			}
			const data = (await res.json()) as { dims: number };
			draftDims = data.dims;
		} catch {
			testError = t('EmbeddingSettingsCard.testFailed');
		} finally {
			testing = false;
		}
	}

	// Set once a successful save actually changed provider/model/dims from
	// what was saved before — this is the "existing indexes must be rebuilt"
	// offer, not shown for a save that only touched distanceThreshold (that
	// never invalidates existing vectors).
	let showReindexOffer = $state(false);
	let reindexOpen = $state(false);

	async function save() {
		if (!draftProviderId || !draftModel.trim() || draftDims === null) return;
		saving = true;
		saveError = '';
		saved = false;
		showReindexOffer = false;
		const previous = config;
		// bind:value on a type="number" input yields a number (or null when
		// cleared), not the string this state started as — normalize first.
		const rawThreshold = String(draftThreshold ?? '').trim();
		const parsedThreshold = rawThreshold ? Number(rawThreshold) : undefined;
		try {
			const res = await fetch('/api/embedding', {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					providerId: draftProviderId,
					model: draftModel.trim(),
					dims: draftDims,
					...(parsedThreshold !== undefined ? { distanceThreshold: parsedThreshold } : {})
				})
			});
			if (!res.ok) {
				const { code, text } = await readErrorBody(res);
				if (code === 'EMBEDDING_CONSENT_REQUIRED') {
					pendingConsentProviderId = draftProviderId;
					pendingConsentAction = 'save';
					return;
				}
				saveError = text;
				return;
			}
			const next = (await res.json()) as EmbeddingConfig;
			config = next;
			saved = true;
			if (previous && (previous.providerId !== next.providerId || previous.model !== next.model || previous.dims !== next.dims)) {
				showReindexOffer = true;
			}
		} catch {
			saveError = t('EmbeddingSettingsCard.saveFailed');
		} finally {
			saving = false;
		}
	}
</script>

<Card.Root class="mb-8">
	<Card.Header>
		<Card.Title level={2}>{t('EmbeddingSettingsCard.title')}</Card.Title>
		<Card.Description>{t('EmbeddingSettingsCard.description')}</Card.Description>
	</Card.Header>
	<Card.Content class="flex flex-col gap-3">
		{#if loadError}
			<p class="text-sm text-destructive" role="alert">{loadError}</p>
		{:else if !loaded}
			<p class="text-sm text-muted-foreground">{t('Common.yukleniyor')}</p>
		{:else}
			<div class="flex flex-col gap-1.5">
				<Label for="{uid}-embed-provider">{t('EmbeddingSettingsCard.providerLabel')}</Label>
				<Select.Root
					type="single"
					value={draftProviderId}
					onValueChange={(v) => {
						draftProviderId = v;
						draftModel = '';
						draftDims = null;
					}}
				>
					<Select.Trigger id="{uid}-embed-provider" class="w-64">
						{providers.find((p) => p.id === draftProviderId)?.label ?? t('EmbeddingSettingsCard.selectProvider')}
					</Select.Trigger>
					<Select.Content>
						{#each embeddingCapable as p (p.id)}
							<Select.Item value={p.id} label={p.label}>{p.label}{p.local ? '' : ` (${t('ProvidersSettingsPage.cloud')})`}</Select.Item>
						{/each}
					</Select.Content>
				</Select.Root>
				{#if embeddingCapable.length === 0}
					<p class="text-xs text-muted-foreground">{t('EmbeddingSettingsCard.noProviders')}</p>
				{/if}
			</div>

			<div class="flex flex-col gap-1.5">
				<Label for="{uid}-embed-model">{t('EmbeddingSettingsCard.modelLabel')}</Label>
				{#if selectedProvider?.kind === 'ollama'}
					<Select.Root type="single" bind:value={draftModel}>
						<Select.Trigger id="{uid}-embed-model" class="w-64">
							{draftModel || t('EmbeddingSettingsCard.modelPlaceholder')}
						</Select.Trigger>
						<Select.Content>
							{#if draftModel && !ollamaModels.some((m) => m.name === draftModel)}
								<Select.Item value={draftModel} label={draftModel}>{draftModel}</Select.Item>
							{/if}
							{#each ollamaModels as m (m.name)}
								<Select.Item value={m.name} label={m.name}>{m.name}</Select.Item>
							{/each}
						</Select.Content>
					</Select.Root>
					{#if ollamaModels.length === 0}
						<p class="text-xs text-muted-foreground">{t('EmbeddingSettingsCard.noOllamaModels')}</p>
					{/if}
				{:else}
					<Input
						id="{uid}-embed-model"
						type="text"
						bind:value={draftModel}
						placeholder={t('EmbeddingSettingsCard.modelPlaceholder')}
						class="max-w-xs"
						disabled={!draftProviderId}
					/>
				{/if}
			</div>

			<div class="flex items-end gap-2">
				<div class="flex flex-col gap-1.5">
					<Label for="{uid}-embed-dims">{t('EmbeddingSettingsCard.dimsLabel')}</Label>
					<Input
						id="{uid}-embed-dims"
						type="number"
						min="1"
						value={draftDims ?? ''}
						oninput={(e) => (draftDims = e.currentTarget.value ? Number(e.currentTarget.value) : null)}
						class="w-28"
					/>
				</div>
				<Button variant="outline" size="sm" disabled={!draftProviderId || !draftModel.trim() || testing} onclick={testDims}>
					{testing ? t('EmbeddingSettingsCard.testing') : t('EmbeddingSettingsCard.testButton')}
				</Button>
			</div>
			{#if testError}
				<p class="text-sm text-destructive" role="alert">{testError}</p>
			{/if}

			<div class="flex flex-col gap-1.5">
				<Label for="{uid}-embed-threshold">{t('EmbeddingSettingsCard.thresholdLabel')}</Label>
				<Input
					id="{uid}-embed-threshold"
					type="number"
					step="0.01"
					min="0"
					bind:value={draftThreshold}
					placeholder={t('EmbeddingSettingsCard.thresholdPlaceholder')}
					class="w-28"
				/>
				{#if !modelIsCalibrated}
					<p class="text-xs text-muted-foreground">{t('EmbeddingSettingsCard.thresholdUncalibrated')}</p>
				{/if}
			</div>

			{#if isCloudSelected}
				<div
					class="flex items-start gap-2 rounded-md border p-3 text-sm"
					style="border-color: var(--warning); background: color-mix(in srgb, var(--warning) 10%, transparent); color: var(--warning);"
					role="alert"
				>
					<TriangleAlertIcon size={16} aria-hidden="true" class="mt-0.5 shrink-0" />
					<span>{t('EmbeddingSettingsCard.cloudWarning', { provider: selectedProvider?.label ?? '' })}</span>
				</div>
			{/if}

			{#if saveError}
				<p class="text-sm text-destructive" role="alert">{saveError}</p>
			{/if}

			<div class="flex items-center gap-2">
				<Button onclick={save} disabled={!draftProviderId || !draftModel.trim() || draftDims === null || saving}>
					{saving ? t('Common.kaydediliyor') : t('Common.kaydet')}
				</Button>
				{#if saved && !showReindexOffer}
					<span class="text-xs text-muted-foreground">{t('EmbeddingSettingsCard.saved')}</span>
				{/if}
			</div>

			{#if showReindexOffer}
				<div class="flex flex-col gap-2 rounded-md border border-primary/40 bg-primary/5 p-3 text-sm">
					<p>{t('EmbeddingSettingsCard.reindexNeeded')}</p>
					{#if activeVaultId}
						<Button size="sm" onclick={() => (reindexOpen = true)}>{t('EmbeddingSettingsCard.reindexNow')}</Button>
					{/if}
				</div>
			{/if}
		{/if}
	</Card.Content>
</Card.Root>

{#if activeVaultId}
	<ReindexDialog vaultId={activeVaultId} bind:open={reindexOpen} onDone={() => (showReindexOffer = false)} />
{/if}

<AlertDialog.Root open={pendingConsentProviderId !== null} onOpenChange={(o) => !o && (pendingConsentProviderId = null)}>
	<AlertDialog.Content>
		{#if pendingConsentProviderId}
			<AlertDialog.Header>
				<AlertDialog.Title>{t('EmbeddingSettingsCard.consentTitle')}</AlertDialog.Title>
				<AlertDialog.Description>
					{t('EmbeddingSettingsCard.consentDescription', {
						provider: providers.find((p) => p.id === pendingConsentProviderId)?.label ?? ''
					})}
				</AlertDialog.Description>
			</AlertDialog.Header>
			<AlertDialog.Footer>
				<AlertDialog.Cancel>{t('Common.iptal')}</AlertDialog.Cancel>
				<AlertDialog.Action
					disabled={consentBusy}
					onclick={(e) => {
						e.preventDefault();
						confirmConsent();
					}}
				>
					{t('EmbeddingSettingsCard.consentConfirm')}
				</AlertDialog.Action>
			</AlertDialog.Footer>
		{/if}
	</AlertDialog.Content>
</AlertDialog.Root>
