<script lang="ts">
	import { onMount } from 'svelte';
	import { isTauri, invoke } from '@tauri-apps/api/core';
	import type { ProviderStatus, ProviderModelOption, ModelListItem, DetectedServer } from '$lib/types';
	import { catalogIdForBaseUrl } from '$lib/localServerMatch';
	import LauncherPanel from '$lib/components/LauncherPanel.svelte';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Switch } from '$lib/components/ui/switch';
	import { Badge } from '$lib/components/ui/badge';
	import * as Card from '$lib/components/ui/card';
	import * as Select from '$lib/components/ui/select';
	import * as AlertDialog from '$lib/components/ui/alert-dialog';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import ArrowUpIcon from '@lucide/svelte/icons/arrow-up';
	import ArrowDownIcon from '@lucide/svelte/icons/arrow-down';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import TrashIcon from '@lucide/svelte/icons/trash';
	import { Label } from '$lib/components/ui/label';
	import EmbeddingSettingsCard from '$lib/components/EmbeddingSettingsCard.svelte';
	import { t, i18n } from '$lib/i18n/index.svelte';
	import { relativeTime } from '$lib/relative-time';
	import { readResponseError } from '$lib/server-error';
	import { flip } from 'svelte/animate';
	import { flipDuration, motionEase } from '$lib/motion';

	// Stable per-instance id prefix for label/control association (see
	// craft-floor's accessibility pass) — $props.id() rather than a literal
	// string so two instances of this page never collide (SSR/hydration-safe).
	const uid = $props.id();

	let TASK_LABELS = $derived<Record<string, string>>({
		chat: t('ProvidersSettingsPage.taskChat'),
		title: t('ProvidersSettingsPage.taskTitle'),
		grading: t('ProvidersSettingsPage.taskGrading'),
		quiz: t('ProvidersSettingsPage.taskQuiz'),
		flashcards: t('ProvidersSettingsPage.taskFlashcards'),
		report: t('ProvidersSettingsPage.taskReport'),
		mindmap: t('ProvidersSettingsPage.taskMindmap'),
		slides: t('ProvidersSettingsPage.taskSlides')
	});

	let providers = $state<ProviderStatus[]>([]);
	let chains = $state<Record<string, string[]>>({});
	let loadError = $state('');

	function patchProvider(id: string, patch: Partial<ProviderStatus>) {
		const idx = providers.findIndex((p) => p.id === id);
		if (idx === -1) return;
		Object.assign(providers[idx], patch);
	}

	// Per-provider "which model to use when the fallback chain reaches this
	// provider without an explicit pin" — see registry.ts's resolveHopModel.
	// /api/providers/models already tags each option with providerId (Chat.svelte's
	// header selector reuses the same endpoint), so no new endpoint is needed —
	// just filter client-side per provider card.
	let providerModels = $state<ProviderModelOption[]>([]);

	function modelsFor(providerId: string): ProviderModelOption[] {
		return providerModels.filter((m) => m.providerId === providerId);
	}

	// F14-4 — "model listesini yönet": lazy per-provider (the catalog fetch/filter this hits is not free),
	// loaded the first time that provider's <details> is opened, not on page mount.
	// Problem B — `pinned` is the provider's raw pinnedModels list (see the /[id]/models GET's own doc
	// comment); rendered as its own removable list regardless of whether the id also shows up in approved/other.
	let modelManage = $state<Record<string, { approved: ModelListItem[]; other: ModelListItem[]; pinned: string[] } | null>>({});
	let modelManageError = $state<Record<string, string>>({});
	let modelManageBusy = $state<Record<string, boolean>>({});
	let pinInputs = $state<Record<string, string>>({});

	async function loadModelManage(providerId: string) {
		if (modelManage[providerId] !== undefined) return; // already loaded (or loading) once
		modelManage[providerId] = null;
		try {
			const res = await fetch(`/api/providers/${encodeURIComponent(providerId)}/models`);
			if (!res.ok) throw new Error();
			modelManage[providerId] = (await res.json()) as { approved: ModelListItem[]; other: ModelListItem[]; pinned: string[] };
		} catch {
			delete modelManage[providerId];
			modelManageError[providerId] = t('ProvidersSettingsPage.modelManageLoadError');
		}
	}

	/** Problem B — "Seçicilere ekle" on an "other" row, or the free-text "model id ekle" input: both funnel
	 * through here, appending to the provider's pinnedModels (deduped/validated server-side too, see
	 * config-store.ts's updatePinnedModels). */
	async function pinModel(providerId: string, modelId: string) {
		const trimmed = modelId.trim();
		if (!trimmed) return;
		const state = modelManage[providerId];
		if (!state || state.pinned.includes(trimmed)) return;
		const nextPinned = [...state.pinned, trimmed];
		modelManageBusy[providerId] = true;
		modelManageError[providerId] = '';
		try {
			const res = await fetch(`/api/providers/${encodeURIComponent(providerId)}`, {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ pinnedModels: nextPinned })
			});
			if (!res.ok) throw new Error();
			state.pinned = nextPinned;
			pinInputs[providerId] = '';
			await refreshProviderModels();
		} catch {
			modelManageError[providerId] = t('ProvidersSettingsPage.modelManageSaveError');
		} finally {
			modelManageBusy[providerId] = false;
		}
	}

	async function unpinModel(providerId: string, modelId: string) {
		const state = modelManage[providerId];
		if (!state) return;
		const nextPinned = state.pinned.filter((id) => id !== modelId);
		modelManageBusy[providerId] = true;
		modelManageError[providerId] = '';
		try {
			const res = await fetch(`/api/providers/${encodeURIComponent(providerId)}`, {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ pinnedModels: nextPinned })
			});
			if (!res.ok) throw new Error();
			state.pinned = nextPinned;
			await refreshProviderModels();
		} catch {
			modelManageError[providerId] = t('ProvidersSettingsPage.modelManageSaveError');
		} finally {
			modelManageBusy[providerId] = false;
		}
	}

	/** Toggling one checkbox materializes the full enabledModels allow-list (every currently-checked id, not
	 * just this one) — the first uncheck is what turns "uncurated, everything approved shows" into an
	 * explicit list; see config-store.ts's ProviderConfigEntry.enabledModels doc comment. */
	async function toggleModelEnabled(providerId: string, modelId: string, checked: boolean) {
		const state = modelManage[providerId];
		if (!state) return;
		for (const item of [...state.approved, ...state.other]) {
			if (item.id === modelId) item.enabled = checked;
		}
		const enabledIds = [...state.approved, ...state.other].filter((m) => m.enabled).map((m) => m.id);
		modelManageBusy[providerId] = true;
		modelManageError[providerId] = '';
		try {
			const res = await fetch(`/api/providers/${encodeURIComponent(providerId)}`, {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ enabledModels: enabledIds })
			});
			if (!res.ok) throw new Error();
			await refreshProviderModels(); // the plain picker list (modelsFor) must reflect the new allow-list too
		} catch {
			modelManageError[providerId] = t('ProvidersSettingsPage.modelManageSaveError');
		} finally {
			modelManageBusy[providerId] = false;
		}
	}

	let keyDrafts = $state<Record<string, string>>({});
	let keyEditingId = $state<string | null>(null);
	let testResults = $state<Record<string, string>>({});
	let testingId = $state<string | null>(null);
	let addChainSelection = $state<Record<string, string>>({});
	let keyDeleteTarget = $state<ProviderStatus | null>(null);

	let addFormOpen = $state(false);
	let addLabel = $state('');
	let addBaseUrl = $state('');
	let addKind = $state<'openai-compat' | 'anthropic' | 'azure-openai'>('openai-compat');
	let addReasoningDialect = $state<'reasoning_content' | 'think-tags' | 'none'>('reasoning_content');
	let addLocal = $state(false);
	let addError = $state('');
	let adding = $state(false);
	let deleteTargetId = $state<string | null>(null);
	let deleteTargetLabel = $state('');

	async function refreshProviders() {
		try {
			const [pRes, cRes] = await Promise.all([
				fetch('/api/providers'),
				fetch('/api/providers/chains')
			]);
			if (!pRes.ok || !cRes.ok) throw new Error();
			providers = (await pRes.json()) as ProviderStatus[];
			chains = (await cRes.json()) as Record<string, string[]>;
		} catch {
			loadError = t('ProvidersSettingsPage.loadError');
		}
	}

	async function refreshProviderModels() {
		try {
			const res = await fetch('/api/providers/models');
			if (res.ok) providerModels = (await res.json()) as ProviderModelOption[];
		} catch {
			// Varsayılan model seçicisi boş kalır — sayfanın geri kalanı çalışır.
		}
	}

	// -- Aşama 2b: local-server launcher panels (Tauri only) --------------

	const tauri = isTauri();
	let localServers = $state<DetectedServer[]>([]);
	let addLocalProviderBusyId = $state<string | null>(null);
	let addLocalProviderError = $state<Record<string, string>>({});

	async function refreshLocalServers() {
		if (!tauri) return;
		try {
			localServers = await invoke<DetectedServer[]>('detect_local_servers');
		} catch {
			localServers = [];
		}
	}

	/** Which catalog id (if any) provider `p` corresponds to — 'ollama' by
	 * kind, or an openai-compat `local: true` provider whose baseUrl port
	 * matches a catalog default (see localServerMatch.ts). Drives both the
	 * inline LauncherPanel on a provider's own card and which catalog
	 * entries the "Yerel sunucular" section below still needs to list. */
	function matchedCatalogId(p: ProviderStatus): string | undefined {
		if (p.id === 'ollama') return 'ollama';
		if (p.kind === 'openai-compat' && p.local) return catalogIdForBaseUrl(p.baseUrl);
		return undefined;
	}

	function localServerMetaFor(catalogId: string): DetectedServer | undefined {
		return localServers.find((s) => s.id === catalogId);
	}

	let shownCatalogIds = $derived(
		new Set(providers.map((p) => matchedCatalogId(p)).filter((id): id is string => !!id))
	);
	/** Launchable catalog entries with no provider card already showing
	 * their LauncherPanel inline — e.g. llama.cpp configured as a launcher
	 * before the user has added a provider entry for it at all. */
	let unclaimedLocalServers = $derived(localServers.filter((s) => s.launchable && !shownCatalogIds.has(s.id)));

	/** Same "add + enable a local openai-compat provider" step
	 * /setup/local-server's ensureProviderForServer does, offered here too
	 * for a catalog entry the user is managing via "Yerel sunucular" but
	 * hasn't turned into a provider yet. */
	async function addProviderForLocalServer(server: DetectedServer) {
		addLocalProviderBusyId = server.id;
		addLocalProviderError = { ...addLocalProviderError, [server.id]: '' };
		try {
			const baseUrl = `http://127.0.0.1:${server.port}/v1`;
			const res = await fetch('/api/providers', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ label: server.display_name, baseUrl, kind: 'openai-compat', local: true })
			});
			if (!res.ok) throw new Error(await readResponseError(res));
			const entry = (await res.json()) as { id: string };
			await fetch(`/api/providers/${encodeURIComponent(entry.id)}`, {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ enabled: true })
			});
			await refresh();
		} catch (err) {
			addLocalProviderError = {
				...addLocalProviderError,
				[server.id]: err instanceof Error ? err.message : String(err)
			};
		} finally {
			addLocalProviderBusyId = null;
		}
	}

	async function refresh() {
		await Promise.all([refreshProviders(), refreshProviderModels(), refreshLocalServers()]);
	}

	async function setDefaultModel(p: ProviderStatus, modelId: string) {
		try {
			const res = await fetch(`/api/providers/${encodeURIComponent(p.id)}`, {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ defaultModel: modelId || null })
			});
			if (!res.ok) throw new Error();
			patchProvider(p.id, { defaultModel: modelId || null });
		} catch {
			loadError = t('ProvidersSettingsPage.defaultModelUpdateFailed', { label: p.label });
		}
	}

	async function addProvider() {
		if (!addLabel.trim() || !addBaseUrl.trim() || adding) return;
		adding = true;
		addError = '';
		try {
			const res = await fetch('/api/providers', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					label: addLabel.trim(),
					baseUrl: addBaseUrl.trim(),
					kind: addKind,
					reasoningDialect: addReasoningDialect,
					local: addKind === 'openai-compat' ? addLocal : false
				})
			});
			if (!res.ok) {
				addError = await readResponseError(res);
				return;
			}
			addLabel = '';
			addBaseUrl = '';
			addLocal = false;
			addFormOpen = false;
			await refresh();
		} catch {
			addError = t('ProvidersSettingsPage.addProviderFailed');
		} finally {
			adding = false;
		}
	}

	async function deleteProvider(id: string) {
		deleteTargetId = null;
		try {
			const res = await fetch('/api/providers', {
				method: 'DELETE',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ id })
			});
			if (!res.ok) throw new Error();
			await refresh();
		} catch {
			loadError = t('ProvidersSettingsPage.providerDeleteFailed');
		}
	}

	onMount(refresh);

	function labelFor(id: string): string {
		return providers.find((p) => p.id === id)?.label ?? id;
	}

	/** Coverage is inherently uneven across providers (see registry.ts's
	 * getRateLimitInfo / RateLimitSnapshot doc comments): Groq/Mistral send
	 * remaining/limit/reset headers on every response ('live'), Gemini/
	 * OpenRouter only ever surface anything via a past 429 recorded in
	 * app-log.jsonl ('log') — and even that is only shown for 24h so a
	 * month-old rate limit doesn't look like it just happened. */
	function rateLimitLabel(p: ProviderStatus): string | null {
		const rl = p.rateLimit;
		if (!rl) return null;
		if (rl.source === 'live') {
			if (rl.remainingRequests !== undefined && rl.limitRequests !== undefined) {
				return t('ProvidersSettingsPage.rateLimitRequests', {
					used: String(rl.limitRequests - rl.remainingRequests),
					limit: String(rl.limitRequests),
					resetTime: rl.resetRequestsAt ? relativeTime(rl.resetRequestsAt, i18n.locale) : '—'
				});
			}
			if (rl.remainingTokens !== undefined && rl.limitTokens !== undefined) {
				return t('ProvidersSettingsPage.rateLimitTokens', {
					used: String(rl.limitTokens - rl.remainingTokens),
					limit: String(rl.limitTokens),
					resetTime: rl.resetTokensAt ? relativeTime(rl.resetTokensAt, i18n.locale) : '—'
				});
			}
			return null;
		}
		if (!rl.lastHitAt || Date.now() - new Date(rl.lastHitAt).getTime() > 24 * 3600 * 1000) return null;
		return t('ProvidersSettingsPage.rateLimitRecent', { time: relativeTime(rl.lastHitAt, i18n.locale) });
	}

	async function toggleEnabled(p: ProviderStatus) {
		const nextEnabled = !p.enabled;
		try {
			const res = await fetch(`/api/providers/${encodeURIComponent(p.id)}`, {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ enabled: nextEnabled })
			});
			if (!res.ok) {
				// Surface the server's reason instead of a generic failure, or a
				// Switch flip that silently reverts would look broken.
				loadError = await readResponseError(res);
				return;
			}
			patchProvider(p.id, { enabled: nextEnabled });
			void refreshProviderModels();
		} catch {
			loadError = t('ProvidersSettingsPage.updateFailed', { label: p.label });
		}
	}

	/** Problem A — toggles ProviderConfigEntry.local on an existing openai-compat provider (no-op server-side
	 * for any other kind). Flips the cloud/local badge and, since isCloud() now reads this, the cloud-consent
	 * gate the model pickers apply — refreshing the picker list afterward keeps that in sync immediately. */
	async function toggleLocal(p: ProviderStatus) {
		const nextLocal = !p.local;
		try {
			const res = await fetch(`/api/providers/${encodeURIComponent(p.id)}`, {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ local: nextLocal })
			});
			if (!res.ok) throw new Error();
			patchProvider(p.id, { local: nextLocal });
			void refreshProviderModels();
		} catch {
			loadError = t('ProvidersSettingsPage.updateFailed', { label: p.label });
		}
	}

	function openKeyEditor(p: ProviderStatus) {
		keyEditingId = p.id;
		keyDrafts[p.id] = '';
	}

	async function saveKey(p: ProviderStatus) {
		const key = (keyDrafts[p.id] ?? '').trim();
		if (!key) return;
		try {
			const res = await fetch(`/api/providers/${encodeURIComponent(p.id)}/key`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ key })
			});
			if (!res.ok) throw new Error();
			const data = (await res.json()) as { keyStatus: 'connected'; mask: string | null };
			keyEditingId = null;
			patchProvider(p.id, { keyStatus: data.keyStatus, mask: data.mask });
			void refreshProviderModels();
		} catch {
			loadError = t('ProvidersSettingsPage.keySaveFailed', { label: p.label });
		}
	}

	function askRemoveKey(p: ProviderStatus) {
		keyDeleteTarget = p;
	}

	async function confirmRemoveKey() {
		const p = keyDeleteTarget;
		if (!p) return;
		keyDeleteTarget = null;
		try {
			const res = await fetch(`/api/providers/${encodeURIComponent(p.id)}/key`, { method: 'DELETE' });
			if (!res.ok) throw new Error();
			patchProvider(p.id, { keyStatus: 'none', mask: null });
			void refreshProviderModels();
		} catch {
			loadError = t('ProvidersSettingsPage.keyDeleteFailed', { label: p.label });
		}
	}

	async function testConnection(p: ProviderStatus) {
		testingId = p.id;
		try {
			const res = await fetch(`/api/providers/${encodeURIComponent(p.id)}/test`, { method: 'POST' });
			const data = (await res.json().catch(() => null)) as { status?: string } | null;
			testResults[p.id] = data?.status ?? 'unreachable';
		} catch {
			testResults[p.id] = 'unreachable';
		} finally {
			testingId = null;
		}
	}

	async function saveChain(taskType: string, providerIds: string[], previous: string[]) {
		chains[taskType] = providerIds;
		try {
			const res = await fetch('/api/providers/chains', {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ taskType, providerIds })
			});
			if (!res.ok) throw new Error();
		} catch {
			chains[taskType] = previous;
			loadError = t('ProvidersSettingsPage.chainUpdateFailed', { taskType: TASK_LABELS[taskType] ?? taskType });
		}
	}

	function moveInChain(taskType: string, index: number, dir: -1 | 1) {
		const previous = chains[taskType] ?? [];
		const chain = [...previous];
		const target = index + dir;
		if (target < 0 || target >= chain.length) return;
		[chain[index], chain[target]] = [chain[target], chain[index]];
		void saveChain(taskType, chain, previous);
	}

	function removeFromChain(taskType: string, index: number) {
		const previous = chains[taskType] ?? [];
		const chain = [...previous];
		chain.splice(index, 1);
		void saveChain(taskType, chain, previous);
	}

	function addToChain(taskType: string) {
		const id = addChainSelection[taskType];
		if (!id) return;
		const previous = chains[taskType] ?? [];
		const chain = [...previous, id];
		addChainSelection[taskType] = '';
		void saveChain(taskType, chain, previous);
	}

	function availableToAdd(taskType: string): ProviderStatus[] {
		const current = new Set(chains[taskType] ?? []);
		return providers.filter((p) => p.enabled && !current.has(p.id));
	}

	let TEST_LABELS = $derived<Record<string, string>>({
		ok: t('ProvidersSettingsPage.testOk'),
		unreachable: t('ProvidersSettingsPage.testUnreachable'),
		auth_error: t('ProvidersSettingsPage.testAuthError')
	});
</script>

<svelte:head>
	<title>{t('ProvidersSettingsPage.title')} — Vault Agent Toolkit</title>
</svelte:head>

<div class="mx-auto max-w-3xl px-4 pt-6 pb-12">
	<div class="mb-3 flex items-baseline gap-4">
		<a href="/settings" class="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-[var(--accent)] focus-visible:outline-offset-2">
			<ArrowLeftIcon size={14} aria-hidden="true" /> {t('Common.ayarlar')}
		</a>
		<h1 class="font-display text-xl font-medium">{t('ProvidersSettingsPage.title')}</h1>
	</div>

	<p class="mb-5 text-sm text-muted-foreground">
		{t('ProvidersSettingsPage.intro', { path: 'data/secrets.json' })}
	</p>

	{#if loadError}
		<p class="mb-4 text-sm text-destructive" role="alert">{loadError}</p>
	{/if}

	<section class="mb-8">
		<div class="mb-3 flex items-baseline justify-between">
			<h2 class="text-base font-semibold">{t('ProvidersSettingsPage.providersSectionTitle')}</h2>
			<Button variant="outline" size="sm" onclick={() => (addFormOpen = !addFormOpen)}>
				<PlusIcon size={14} aria-hidden="true" /> {t('ProvidersSettingsPage.addProvider')}
			</Button>
		</div>

		{#if addFormOpen}
			<Card.Root class="mb-4">
				<Card.Content class="flex flex-col gap-3">
					<h3 class="text-sm font-semibold">{t('ProvidersSettingsPage.newProviderTitle')}</h3>
					<div class="flex flex-col gap-1.5">
						<Label for="{uid}-name">{t('ProvidersSettingsPage.nameLabel')}</Label>
						<Input id="{uid}-name" type="text" bind:value={addLabel} placeholder={t('ProvidersSettingsPage.namePlaceholder')} class="max-w-xs" />
					</div>
					<div class="flex flex-col gap-1.5">
						<Label for="{uid}-base-url">{t('ProvidersSettingsPage.baseUrlLabel')}</Label>
						<Input id="{uid}-base-url" type="text" bind:value={addBaseUrl} placeholder={t('ProvidersSettingsPage.baseUrlPlaceholder')} class="max-w-sm" />
					</div>
					<div class="flex flex-col gap-1.5">
						<Label for="{uid}-kind">{t('ProvidersSettingsPage.kindLabel')}</Label>
						<Select.Root type="single" bind:value={addKind}>
							<Select.Trigger id="{uid}-kind" class="w-44">
								{addKind === 'openai-compat'
									? t('ProvidersSettingsPage.kindOpenAICompat')
									: addKind === 'azure-openai'
										? t('ProvidersSettingsPage.kindAzureOpenAI')
										: t('ProvidersSettingsPage.kindAnthropic')}
							</Select.Trigger>
							<Select.Content>
								<Select.Item value="openai-compat" label={t('ProvidersSettingsPage.kindOpenAICompat')}>{t('ProvidersSettingsPage.kindOpenAICompatFull')}</Select.Item>
								<Select.Item value="anthropic" label={t('ProvidersSettingsPage.kindAnthropic')}>{t('ProvidersSettingsPage.kindAnthropic')}</Select.Item>
								<Select.Item value="azure-openai" label={t('ProvidersSettingsPage.kindAzureOpenAI')}>{t('ProvidersSettingsPage.kindAzureOpenAI')}</Select.Item>
							</Select.Content>
						</Select.Root>
					</div>
					{#if addKind === 'openai-compat'}
						<div class="flex flex-col gap-1.5">
							<Label for="{uid}-reasoning-dialect">{t('ProvidersSettingsPage.reasoningDialectLabel')}</Label>
							<Select.Root type="single" bind:value={addReasoningDialect}>
								<Select.Trigger id="{uid}-reasoning-dialect" class="w-44">
									{addReasoningDialect === 'reasoning_content' ? t('ProvidersSettingsPage.reasoningDialectReasoningContent') : addReasoningDialect === 'think-tags' ? t('ProvidersSettingsPage.reasoningDialectThinkTags') : t('ProvidersSettingsPage.reasoningDialectNone')}
								</Select.Trigger>
								<Select.Content>
									<Select.Item value="reasoning_content" label="reasoning_content">{t('ProvidersSettingsPage.reasoningDialectReasoningContent')}</Select.Item>
									<Select.Item value="think-tags" label="think-tags">{t('ProvidersSettingsPage.reasoningDialectThinkTagsFull')}</Select.Item>
									<Select.Item value="none" label="none">{t('ProvidersSettingsPage.reasoningDialectNone')}</Select.Item>
								</Select.Content>
							</Select.Root>
						</div>
						<label class="flex cursor-pointer items-start gap-1.5 text-sm">
							<Checkbox checked={addLocal} onCheckedChange={(v: boolean) => (addLocal = v)} class="mt-0.5" />
							<span>
								{t('ProvidersSettingsPage.localCheckboxLabel')}
								<span class="block text-xs text-muted-foreground">{t('ProvidersSettingsPage.localCheckboxHint')}</span>
							</span>
						</label>
					{/if}
					{#if addKind === 'azure-openai'}
						<p class="text-xs text-muted-foreground">{t('ProvidersSettingsPage.azureHint')}</p>
					{/if}
					{#if addError}
						<p class="text-sm text-destructive" role="alert">{addError}</p>
					{/if}
					<div class="flex gap-2">
						<Button onclick={addProvider} disabled={!addLabel.trim() || !addBaseUrl.trim() || adding}>
							{adding ? t('ProvidersSettingsPage.adding') : t('ProvidersSettingsPage.add')}
						</Button>
						<Button variant="ghost" onclick={() => { addFormOpen = false; addError = ''; }}>{t('Common.vazgec')}</Button>
					</div>
				</Card.Content>
			</Card.Root>
		{/if}

		<div class="flex flex-col gap-3">
			{#each providers as p (p.id)}
				<Card.Root>
					<Card.Content class="flex flex-wrap justify-between gap-4">
						<div class="min-w-[220px] flex-1">
							<div class="flex flex-wrap items-center gap-1.5">
								<strong class="text-sm">{p.label}</strong>
								<Badge variant="outline">{p.local ? t('ProvidersSettingsPage.local') : t('ProvidersSettingsPage.cloud')}</Badge>
								{#if p.needsKey}
									<Badge variant={p.keyStatus === 'connected' ? 'default' : 'outline'}>
										{p.keyStatus === 'connected' ? t('ProvidersSettingsPage.keyConnected', { mask: p.mask ?? '' }) : t('ProvidersSettingsPage.keyMissing')}
									</Badge>
								{/if}
							</div>
							<p class="mt-1 text-xs text-muted-foreground">{p.baseUrl}</p>
							{#if rateLimitLabel(p)}
								<p class="mt-1 text-xs text-amber-600 dark:text-amber-500">{rateLimitLabel(p)}</p>
							{/if}

							{#if tauri && matchedCatalogId(p) && localServerMetaFor(matchedCatalogId(p) ?? '')}
								{@const meta = localServerMetaFor(matchedCatalogId(p) ?? '')}
								{#if meta}
									<LauncherPanel serverId={meta.id} displayName={p.label} defaultPort={meta.port} launchable={meta.launchable} />
								{/if}
							{/if}

							<div class="mt-2 flex flex-col gap-1">
								<Label for="{uid}-default-model-{p.id}" class="text-xs text-muted-foreground">{t('ProvidersSettingsPage.defaultModelLabel')}</Label>
								<!-- Sadece bu sağlayıcı başarısız olan BİR ÖNCEKİ sağlayıcının
								     yerine zincirde denendiğinde kullanılır — açıkça seçilen bir
								     model asla değiştirilmez. Boş bırakılırsa (model listesi
								     boşsa da) bu sağlayıcı, düşüş (fallback) yolunda atlanır;
								     görev-Modeli hatası yerine ait olduğu sağlayıcının kendi
								     hatası görünür. Bkz. registry.ts'nin resolveHopModel'i. -->
								{#if modelsFor(p.id).length > 0}
									<Select.Root
										type="single"
										value={p.defaultModel ?? ''}
										onValueChange={(v) => setDefaultModel(p, v)}
									>
										<Select.Trigger id="{uid}-default-model-{p.id}" size="sm" class="w-52">
											{p.defaultModel ?? t('ProvidersSettingsPage.notSelected')}
										</Select.Trigger>
										<Select.Content>
											{#each modelsFor(p.id) as m (m.id)}
												<Select.Item value={m.id} label={m.id}>{m.id}</Select.Item>
											{/each}
										</Select.Content>
									</Select.Root>
								{:else}
									<span class="text-xs text-muted-foreground">
										{p.defaultModel ?? t('ProvidersSettingsPage.noModelList')}
									</span>
								{/if}
							</div>

							<details class="mt-2 text-xs" ontoggle={(e) => e.currentTarget.open && loadModelManage(p.id)}>
								<summary class="cursor-pointer text-muted-foreground">{t('ProvidersSettingsPage.manageModels')}</summary>
								<div class="mt-2 flex flex-col gap-1 pl-2">
									{#if modelManageError[p.id]}
										<p class="text-destructive">{modelManageError[p.id]}</p>
									{:else if modelManage[p.id] === undefined || modelManage[p.id] === null}
										<p class="text-muted-foreground">{t('Common.yukleniyor')}</p>
									{:else}
										{#if modelManage[p.id]!.approved.length === 0 && modelManage[p.id]!.other.length === 0}
											<p class="text-muted-foreground">{t('ProvidersSettingsPage.noModelList')}</p>
										{/if}
										{#each modelManage[p.id]!.approved as m (m.id)}
											<label class="flex cursor-pointer items-center gap-1.5">
												<Checkbox
													checked={m.enabled}
													disabled={modelManageBusy[p.id]}
													onCheckedChange={(v: boolean) => toggleModelEnabled(p.id, m.id, v)}
												/>
												{m.id}
											</label>
										{/each}
										{#if modelManage[p.id]!.other.length > 0}
											<details class="mt-1">
												<summary class="cursor-pointer text-muted-foreground">
													{t('ProvidersSettingsPage.otherModels', { count: modelManage[p.id]!.other.length })}
												</summary>
												<div class="mt-1 flex flex-col gap-1 pl-2">
													{#each modelManage[p.id]!.other as m (m.id)}
														<div class="flex items-center gap-1.5">
															<Checkbox
																checked={m.enabled}
																disabled={modelManageBusy[p.id]}
																onCheckedChange={(v: boolean) => toggleModelEnabled(p.id, m.id, v)}
															/>
															<span class="flex-1">{m.id}</span>
															{#if !modelManage[p.id]!.pinned.includes(m.id)}
																<Button
																	size="sm"
																	variant="ghost"
																	class="h-6 px-1.5 text-xs"
																	disabled={modelManageBusy[p.id]}
																	onclick={() => pinModel(p.id, m.id)}
																>
																	{t('ProvidersSettingsPage.pinModel')}
																</Button>
															{/if}
														</div>
													{/each}
												</div>
											</details>
										{/if}
										<!-- Problem B — pinnedModels: yakalanan (approved/other) listede olsun ya da
										     olmasın, kullanıcının kendi seçtiği model id'lerinin ayrı, silinebilir
										     listesi. Kaynak: config-store.ts'nin pinnedModels alanı. -->
										<div class="mt-2 flex flex-col gap-1 border-t pt-2">
											<span class="text-muted-foreground">{t('ProvidersSettingsPage.pinnedModelsTitle')}</span>
											{#if modelManage[p.id]!.pinned.length === 0}
												<p class="text-muted-foreground">{t('ProvidersSettingsPage.pinnedModelsEmpty')}</p>
											{:else}
												{#each modelManage[p.id]!.pinned as modelId (modelId)}
													<div class="flex items-center gap-1.5">
														<span class="flex-1">{modelId}</span>
														<Button
															size="sm"
															variant="ghost"
															class="h-6 px-1.5 text-xs text-destructive hover:text-destructive"
															disabled={modelManageBusy[p.id]}
															onclick={() => unpinModel(p.id, modelId)}
														>
															{t('ProvidersSettingsPage.unpinModel')}
														</Button>
													</div>
												{/each}
											{/if}
											<div class="mt-1 flex gap-1.5">
												<Input
													type="text"
													placeholder={t('ProvidersSettingsPage.pinModelIdPlaceholder')}
													aria-label={t('ProvidersSettingsPage.pinModelIdPlaceholder')}
													bind:value={pinInputs[p.id]}
													class="h-7 max-w-[220px] text-xs"
													onkeydown={(e) => e.key === 'Enter' && pinModel(p.id, pinInputs[p.id] ?? '')}
												/>
												<Button
													size="sm"
													variant="outline"
													class="h-7 px-2 text-xs"
													disabled={modelManageBusy[p.id] || !(pinInputs[p.id] ?? '').trim()}
													onclick={() => pinModel(p.id, pinInputs[p.id] ?? '')}
												>
													{t('ProvidersSettingsPage.pinModelIdAdd')}
												</Button>
											</div>
										</div>
									{/if}
								</div>
							</details>

							{#if keyEditingId === p.id}
								<div class="mt-2 flex gap-1.5">
									<Input
										type="password"
										placeholder={t('ProvidersSettingsPage.apiKeyPlaceholder')}
										aria-label={t('ProvidersSettingsPage.apiKeyPlaceholder')}
										bind:value={keyDrafts[p.id]}
										class="h-8 max-w-xs"
										onkeydown={(e) => e.key === 'Enter' && saveKey(p)}
									/>
									<Button size="sm" onclick={() => saveKey(p)}>{t('Common.kaydet')}</Button>
									<Button size="sm" variant="ghost" onclick={() => (keyEditingId = null)}>{t('Common.iptal')}</Button>
								</div>
							{/if}

							{#if testResults[p.id]}
								<p class="mt-1.5 text-xs">{TEST_LABELS[testResults[p.id]] ?? testResults[p.id]}</p>
							{/if}
						</div>

						<div class="flex flex-wrap items-center gap-2">
							<label class="flex cursor-pointer items-center gap-1.5 text-xs">
								<Switch checked={p.enabled} onCheckedChange={() => toggleEnabled(p)} />
								{t('ProvidersSettingsPage.enabled')}
							</label>
							{#if p.kind === 'openai-compat'}
								<label class="flex cursor-pointer items-center gap-1.5 text-xs" title={t('ProvidersSettingsPage.localCheckboxHint')}>
									<Switch checked={p.local} onCheckedChange={() => toggleLocal(p)} />
									{t('ProvidersSettingsPage.localCheckboxLabel')}
								</label>
							{/if}
							{#if p.needsKey}
								<Button size="sm" variant="outline" onclick={() => openKeyEditor(p)}>
									{p.keyStatus === 'connected' ? t('ProvidersSettingsPage.changeKey') : t('ProvidersSettingsPage.addKey')}
								</Button>
								{#if p.keyStatus === 'connected'}
									<Button size="sm" variant="destructive" onclick={() => askRemoveKey(p)}>
										{t('ProvidersSettingsPage.removeKey')}
									</Button>
								{/if}
							{/if}
							<Button size="sm" variant="outline" onclick={() => testConnection(p)} disabled={testingId === p.id}>
								{testingId === p.id ? t('ProvidersSettingsPage.testing') : t('ProvidersSettingsPage.testConnection')}
							</Button>
							{#if p.id !== 'ollama'}
								<Button
									size="sm"
									variant="ghost"
									class="text-destructive hover:text-destructive"
									title={t('ProvidersSettingsPage.removeProviderTitle')}
									aria-label={t('ProvidersSettingsPage.removeProviderAria', { label: p.label })}
									onclick={() => {
										deleteTargetId = p.id;
										deleteTargetLabel = p.label;
									}}
								>
									<TrashIcon size={14} aria-hidden="true" />
								</Button>
							{/if}
						</div>
					</Card.Content>
				</Card.Root>
			{/each}
		</div>
	</section>

	<!-- Aşama 3c — depends on the provider list above (its own provider
	     select is "enabled ollama/openai-compat providers" from `providers`),
	     so it sits right after that section rather than before it or on a
	     separate page. See the component's own doc comment. -->
	<EmbeddingSettingsCard {providers} />

	{#if tauri && unclaimedLocalServers.length > 0}
		<section class="mb-8">
			<h2 class="mb-1 text-base font-semibold">{t('ProvidersSettingsPage.localServersTitle')}</h2>
			<p class="mb-4 text-sm text-muted-foreground">{t('ProvidersSettingsPage.localServersDescription')}</p>
			<div class="flex flex-col gap-3">
				{#each unclaimedLocalServers as server (server.id)}
					<Card.Root>
						<Card.Content>
							<strong class="text-sm">{server.display_name}</strong>
							<LauncherPanel serverId={server.id} displayName={server.display_name} defaultPort={server.port} launchable={server.launchable} />
							<div class="mt-2">
								<Button size="sm" variant="outline" onclick={() => addProviderForLocalServer(server)} disabled={addLocalProviderBusyId === server.id}>
									{addLocalProviderBusyId === server.id ? t('Common.kaydediliyor') : t('ProvidersSettingsPage.addAsProvider')}
								</Button>
							</div>
							{#if addLocalProviderError[server.id]}
								<p class="mt-2 text-sm text-destructive" role="alert">{addLocalProviderError[server.id]}</p>
							{/if}
						</Card.Content>
					</Card.Root>
				{/each}
			</div>
		</section>
	{/if}

	<section>
		<h2 class="mb-1 text-base font-semibold">{t('ProvidersSettingsPage.chainSectionTitle')}</h2>
		<p class="mb-4 text-sm text-muted-foreground">
			{t('ProvidersSettingsPage.chainSectionDescription')}
		</p>
		{#each Object.keys(TASK_LABELS) as taskType (taskType)}
			<div class="flex flex-wrap items-center gap-3 border-b py-2.5">
				<span class="min-w-[140px] text-sm font-semibold">{TASK_LABELS[taskType]}</span>
				<div class="flex flex-1 flex-wrap gap-1.5">
					{#each chains[taskType] ?? [] as providerId, i (providerId)}
						<span
							class="inline-flex items-center gap-0.5 rounded-full border py-0.5 pr-1.5 pl-2.5 text-xs"
							animate:flip={{ duration: flipDuration(), easing: motionEase }}
						>
							{labelFor(providerId)}
							<button
								type="button"
								class="flex items-center px-0.5 text-muted-foreground disabled:opacity-30"
								title={t('ProvidersSettingsPage.moveUp')}
								aria-label={t('ProvidersSettingsPage.moveUp')}
								disabled={i === 0}
								onclick={() => moveInChain(taskType, i, -1)}><ArrowUpIcon size={12} aria-hidden="true" /></button
							>
							<button
								type="button"
								class="flex items-center px-0.5 text-muted-foreground disabled:opacity-30"
								title={t('ProvidersSettingsPage.moveDown')}
								aria-label={t('ProvidersSettingsPage.moveDown')}
								disabled={i === (chains[taskType]?.length ?? 0) - 1}
								onclick={() => moveInChain(taskType, i, 1)}><ArrowDownIcon size={12} aria-hidden="true" /></button
							>
							<button
								type="button"
								class="px-0.5 text-muted-foreground"
								title={t('ProvidersSettingsPage.removeFromChain')}
								onclick={() => removeFromChain(taskType, i)}>×</button
							>
						</span>
					{:else}
						<span class="text-sm text-muted-foreground">{t('ProvidersSettingsPage.chainEmpty')}</span>
					{/each}
				</div>
				{#if availableToAdd(taskType).length > 0}
					<div class="flex gap-1.5">
						<Select.Root type="single" bind:value={addChainSelection[taskType]}>
							<Select.Trigger size="sm" class="w-44">
								{addChainSelection[taskType]
									? labelFor(addChainSelection[taskType])
									: t('ProvidersSettingsPage.addToChainPlaceholder')}
							</Select.Trigger>
							<Select.Content>
								{#each availableToAdd(taskType) as p (p.id)}
									<Select.Item value={p.id} label={p.label}>{p.label}</Select.Item>
								{/each}
							</Select.Content>
						</Select.Root>
						<Button size="sm" variant="outline" onclick={() => addToChain(taskType)}>{t('ProvidersSettingsPage.add')}</Button>
					</div>
				{/if}
			</div>
		{/each}
	</section>
</div>

<AlertDialog.Root
	open={!!keyDeleteTarget || !!deleteTargetId}
	onOpenChange={(open) => {
		if (!open) {
			keyDeleteTarget = null;
			deleteTargetId = null;
		}
	}}
>
	<AlertDialog.Content>
		{#if keyDeleteTarget}
			<AlertDialog.Header>
				<AlertDialog.Title>{t('ProvidersSettingsPage.keyDeleteConfirmTitle', { label: keyDeleteTarget.label })}</AlertDialog.Title>
				<AlertDialog.Description>
					{t('ProvidersSettingsPage.keyDeleteConfirmDescription')}
				</AlertDialog.Description>
			</AlertDialog.Header>
			<AlertDialog.Footer>
				<AlertDialog.Cancel>{t('Common.vazgec')}</AlertDialog.Cancel>
				<AlertDialog.Action
					variant="destructive"
					onclick={(e) => {
						e.preventDefault();
						confirmRemoveKey();
					}}
				>
					{t('Common.sil')}
				</AlertDialog.Action>
			</AlertDialog.Footer>
		{:else if deleteTargetId}
			<AlertDialog.Header>
				<AlertDialog.Title>{t('ProvidersSettingsPage.providerDeleteConfirmTitle', { label: deleteTargetLabel })}</AlertDialog.Title>
				<AlertDialog.Description>
					{t('ProvidersSettingsPage.providerDeleteConfirmDescription')}
				</AlertDialog.Description>
			</AlertDialog.Header>
			<AlertDialog.Footer>
				<AlertDialog.Cancel>{t('Common.vazgec')}</AlertDialog.Cancel>
				<AlertDialog.Action
					variant="destructive"
					onclick={(e) => {
						e.preventDefault();
						if (deleteTargetId) deleteProvider(deleteTargetId);
					}}
				>
					{t('ProvidersSettingsPage.removeProvider')}
				</AlertDialog.Action>
			</AlertDialog.Footer>
		{/if}
	</AlertDialog.Content>
</AlertDialog.Root>
