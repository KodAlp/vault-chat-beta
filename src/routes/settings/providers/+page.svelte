<script lang="ts">
	import { onMount } from 'svelte';
	import type { ProviderStatus } from '$lib/types';
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

	const TASK_LABELS: Record<string, string> = {
		chat: 'Sohbet',
		title: 'Başlık üretimi',
		grading: 'Notlandırma',
		quiz: 'Test üretimi',
		flashcards: 'Bilgi kartı üretimi'
	};

	let providers = $state<ProviderStatus[]>([]);
	let chains = $state<Record<string, string[]>>({});
	let loadError = $state('');

	let keyDrafts = $state<Record<string, string>>({});
	let keyEditingId = $state<string | null>(null);
	let testResults = $state<Record<string, string>>({});
	let testingId = $state<string | null>(null);
	let addChainSelection = $state<Record<string, string>>({});
	let keyDeleteTarget = $state<ProviderStatus | null>(null);

	let addFormOpen = $state(false);
	let addLabel = $state('');
	let addBaseUrl = $state('');
	let addKind = $state<'openai-compat' | 'anthropic'>('openai-compat');
	let addReasoningDialect = $state<'reasoning_content' | 'think-tags' | 'none'>('reasoning_content');
	let addError = $state('');
	let adding = $state(false);
	let deleteTargetId = $state<string | null>(null);
	let deleteTargetLabel = $state('');

	async function refresh() {
		try {
			const [pRes, cRes] = await Promise.all([
				fetch('/api/providers'),
				fetch('/api/providers/chains')
			]);
			if (!pRes.ok || !cRes.ok) throw new Error();
			providers = (await pRes.json()) as ProviderStatus[];
			chains = (await cRes.json()) as Record<string, string[]>;
		} catch {
			loadError = 'Sağlayıcı listesi alınamadı.';
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
					reasoningDialect: addReasoningDialect
				})
			});
			if (!res.ok) {
				const data = (await res.json().catch(() => null)) as { error?: string } | null;
				throw new Error(data?.error ?? 'Sağlayıcı eklenemedi');
			}
			addLabel = '';
			addBaseUrl = '';
			addFormOpen = false;
			await refresh();
		} catch (err) {
			addError = err instanceof Error ? err.message : 'Sağlayıcı eklenemedi';
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
			loadError = 'Sağlayıcı silinemedi.';
		}
	}

	onMount(refresh);

	function labelFor(id: string): string {
		return providers.find((p) => p.id === id)?.label ?? id;
	}

	async function toggleEnabled(p: ProviderStatus) {
		try {
			const res = await fetch(`/api/providers/${encodeURIComponent(p.id)}`, {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ enabled: !p.enabled })
			});
			if (!res.ok) throw new Error();
			await refresh();
		} catch {
			loadError = `"${p.label}" güncellenemedi.`;
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
			keyEditingId = null;
			await refresh();
		} catch {
			loadError = `"${p.label}" anahtarı kaydedilemedi.`;
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
			await refresh();
		} catch {
			loadError = `"${p.label}" anahtarı silinemedi.`;
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

	async function saveChain(taskType: string, providerIds: string[]) {
		try {
			const res = await fetch('/api/providers/chains', {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ taskType, providerIds })
			});
			if (!res.ok) throw new Error();
			chains[taskType] = providerIds;
		} catch {
			loadError = `"${TASK_LABELS[taskType] ?? taskType}" zinciri güncellenemedi.`;
		}
	}

	function moveInChain(taskType: string, index: number, dir: -1 | 1) {
		const chain = [...(chains[taskType] ?? [])];
		const target = index + dir;
		if (target < 0 || target >= chain.length) return;
		[chain[index], chain[target]] = [chain[target], chain[index]];
		void saveChain(taskType, chain);
	}

	function removeFromChain(taskType: string, index: number) {
		const chain = [...(chains[taskType] ?? [])];
		chain.splice(index, 1);
		void saveChain(taskType, chain);
	}

	function addToChain(taskType: string) {
		const id = addChainSelection[taskType];
		if (!id) return;
		const chain = [...(chains[taskType] ?? []), id];
		addChainSelection[taskType] = '';
		void saveChain(taskType, chain);
	}

	function availableToAdd(taskType: string): ProviderStatus[] {
		const current = new Set(chains[taskType] ?? []);
		return providers.filter((p) => p.enabled && !current.has(p.id));
	}

	const TEST_LABELS: Record<string, string> = {
		ok: 'Bağlantı OK',
		unreachable: 'Ulaşılamıyor',
		auth_error: 'Kimlik doğrulama hatası'
	};
</script>

<svelte:head>
	<title>Model Sağlayıcıları — Vault Agent Toolkit</title>
</svelte:head>

<div class="mx-auto max-w-3xl px-4 pt-6 pb-12">
	<div class="mb-3 flex items-baseline gap-4">
		<a href="/settings" class="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-[var(--accent)] focus-visible:outline-offset-2">
			<ArrowLeftIcon size={14} aria-hidden="true" /> Ayarlar
		</a>
		<h1 class="font-display text-xl font-medium">Model Sağlayıcıları</h1>
	</div>

	<p class="mb-5 text-sm text-muted-foreground">
		Yerel Ollama'yı ve isteğe bağlı bulut sağlayıcıları (DeepSeek, OpenAI, ...) yönet. Anahtarlar
		sunucuda <code class="rounded bg-muted px-1 py-0.5 text-xs">data/secrets.json</code> içinde kalır,
		hiçbir zaman tarayıcıya gönderilmez.
	</p>

	{#if loadError}
		<p class="mb-4 text-sm text-destructive" role="alert">{loadError}</p>
	{/if}

	<section class="mb-8">
		<div class="mb-3 flex items-baseline justify-between">
			<h2 class="text-base font-semibold">Sağlayıcılar</h2>
			<Button variant="outline" size="sm" onclick={() => (addFormOpen = !addFormOpen)}>
				<PlusIcon size={14} aria-hidden="true" /> Sağlayıcı ekle
			</Button>
		</div>

		{#if addFormOpen}
			<Card.Root class="mb-4">
				<Card.Content class="flex flex-col gap-3">
					<h3 class="text-sm font-semibold">Yeni sağlayıcı</h3>
					<div class="flex flex-col gap-1.5">
						<Label>İsim</Label>
						<Input type="text" bind:value={addLabel} placeholder="örn. OpenAI" class="max-w-xs" />
					</div>
					<div class="flex flex-col gap-1.5">
						<Label>API uç noktası (base URL)</Label>
						<Input type="text" bind:value={addBaseUrl} placeholder="örn. https://api.openai.com/v1" class="max-w-sm" />
					</div>
					<div class="flex flex-col gap-1.5">
						<Label>API türü</Label>
						<Select.Root type="single" bind:value={addKind}>
							<Select.Trigger class="w-44">
								{addKind === 'openai-compat' ? 'OpenAI-uyumlu' : 'Anthropic (Claude)'}
							</Select.Trigger>
							<Select.Content>
								<Select.Item value="openai-compat" label="OpenAI-uyumlu">OpenAI-uyumlu (OpenAI, Groq, OpenRouter, ...)</Select.Item>
								<Select.Item value="anthropic" label="Anthropic (Claude)">Anthropic (Claude)</Select.Item>
							</Select.Content>
						</Select.Root>
					</div>
					{#if addKind === 'openai-compat'}
						<div class="flex flex-col gap-1.5">
							<Label>Muhakeme formatı</Label>
							<Select.Root type="single" bind:value={addReasoningDialect}>
								<Select.Trigger class="w-44">
									{addReasoningDialect === 'reasoning_content' ? 'reasoning_content (DeepSeek, Ollama)' : addReasoningDialect === 'think-tags' ? 'think-tags (Qwen, Gemma inline)' : 'Yok'}
								</Select.Trigger>
								<Select.Content>
									<Select.Item value="reasoning_content" label="reasoning_content">reasoning_content (DeepSeek, Ollama)</Select.Item>
									<Select.Item value="think-tags" label="think-tags">think-tags (Qwen, Gemma — inline)</Select.Item>
									<Select.Item value="none" label="none">Yok</Select.Item>
								</Select.Content>
							</Select.Root>
						</div>
					{/if}
					{#if addError}
						<p class="text-sm text-destructive" role="alert">{addError}</p>
					{/if}
					<div class="flex gap-2">
						<Button onclick={addProvider} disabled={!addLabel.trim() || !addBaseUrl.trim() || adding}>
							{adding ? 'Ekleniyor...' : 'Ekle'}
						</Button>
						<Button variant="ghost" onclick={() => { addFormOpen = false; addError = ''; }}>Vazgeç</Button>
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
								<Badge variant="outline">{p.kind === 'ollama' ? 'yerel' : 'bulut'}</Badge>
								{#if p.needsKey}
									<Badge variant={p.keyStatus === 'connected' ? 'default' : 'outline'}>
										{p.keyStatus === 'connected' ? `bağlı · ${p.mask}` : 'anahtar yok'}
									</Badge>
								{/if}
							</div>
							<p class="mt-1 text-xs text-muted-foreground">{p.baseUrl}</p>

							{#if keyEditingId === p.id}
								<div class="mt-2 flex gap-1.5">
									<Input
										type="password"
										placeholder="API anahtarı"
										bind:value={keyDrafts[p.id]}
										class="h-8 max-w-xs"
										onkeydown={(e) => e.key === 'Enter' && saveKey(p)}
									/>
									<Button size="sm" onclick={() => saveKey(p)}>Kaydet</Button>
									<Button size="sm" variant="ghost" onclick={() => (keyEditingId = null)}>İptal</Button>
								</div>
							{/if}

							{#if testResults[p.id]}
								<p class="mt-1.5 text-xs">{TEST_LABELS[testResults[p.id]] ?? testResults[p.id]}</p>
							{/if}
						</div>

						<div class="flex flex-wrap items-center gap-2">
							<label class="flex cursor-pointer items-center gap-1.5 text-xs">
								<Switch checked={p.enabled} onCheckedChange={() => toggleEnabled(p)} />
								Etkin
							</label>
							{#if p.needsKey}
								<Button size="sm" variant="outline" onclick={() => openKeyEditor(p)}>
									{p.keyStatus === 'connected' ? 'Anahtarı değiştir' : 'Anahtar ekle'}
								</Button>
								{#if p.keyStatus === 'connected'}
									<Button size="sm" variant="destructive" onclick={() => askRemoveKey(p)}>
										Anahtarı sil
									</Button>
								{/if}
							{/if}
							<Button size="sm" variant="outline" onclick={() => testConnection(p)} disabled={testingId === p.id}>
								{testingId === p.id ? 'Test ediliyor...' : 'Bağlantıyı test et'}
							</Button>
							{#if p.id !== 'ollama'}
								<Button
									size="sm"
									variant="ghost"
									class="text-destructive hover:text-destructive"
									title="Sağlayıcıyı kaldır"
									aria-label={`${p.label} sağlayıcısını kaldır`}
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

	<section>
		<h2 class="mb-1 text-base font-semibold">Görev başına varsayılan zincir</h2>
		<p class="mb-4 text-sm text-muted-foreground">
			Her görev tipi için sırayla denenecek sağlayıcılar. İlk sağlayıcı yanıt veremezse (ağ hatası,
			zaman aşımı) bir sonrakine geçilir — yanlış API anahtarı gibi kalıcı hatalarda geçiş yapılmaz.
		</p>
		{#each Object.keys(TASK_LABELS) as taskType (taskType)}
			<div class="flex flex-wrap items-center gap-3 border-b py-2.5">
				<span class="min-w-[140px] text-sm font-semibold">{TASK_LABELS[taskType]}</span>
				<div class="flex flex-1 flex-wrap gap-1.5">
					{#each chains[taskType] ?? [] as providerId, i (providerId + i)}
						<span class="inline-flex items-center gap-0.5 rounded-full border py-0.5 pr-1.5 pl-2.5 text-xs">
							{labelFor(providerId)}
							<button
								type="button"
								class="flex items-center px-0.5 text-muted-foreground disabled:opacity-30"
								title="Yukarı taşı"
								aria-label="Yukarı taşı"
								disabled={i === 0}
								onclick={() => moveInChain(taskType, i, -1)}><ArrowUpIcon size={12} aria-hidden="true" /></button
							>
							<button
								type="button"
								class="flex items-center px-0.5 text-muted-foreground disabled:opacity-30"
								title="Aşağı taşı"
								aria-label="Aşağı taşı"
								disabled={i === (chains[taskType]?.length ?? 0) - 1}
								onclick={() => moveInChain(taskType, i, 1)}><ArrowDownIcon size={12} aria-hidden="true" /></button
							>
							<button
								type="button"
								class="px-0.5 text-muted-foreground"
								title="Kaldır"
								onclick={() => removeFromChain(taskType, i)}>×</button
							>
						</span>
					{:else}
						<span class="text-sm text-muted-foreground">zincir boş</span>
					{/each}
				</div>
				{#if availableToAdd(taskType).length > 0}
					<div class="flex gap-1.5">
						<Select.Root type="single" bind:value={addChainSelection[taskType]}>
							<Select.Trigger size="sm" class="w-44">
								{addChainSelection[taskType]
									? labelFor(addChainSelection[taskType])
									: 'sağlayıcı ekle...'}
							</Select.Trigger>
							<Select.Content>
								{#each availableToAdd(taskType) as p (p.id)}
									<Select.Item value={p.id} label={p.label}>{p.label}</Select.Item>
								{/each}
							</Select.Content>
						</Select.Root>
						<Button size="sm" variant="outline" onclick={() => addToChain(taskType)}>Ekle</Button>
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
				<AlertDialog.Title>"{keyDeleteTarget.label}" anahtarı silinsin mi?</AlertDialog.Title>
				<AlertDialog.Description>
					Bu sağlayıcı için kayıtlı API anahtarı kalıcı olarak silinecek.
				</AlertDialog.Description>
			</AlertDialog.Header>
			<AlertDialog.Footer>
				<AlertDialog.Cancel>Vazgeç</AlertDialog.Cancel>
				<AlertDialog.Action
					variant="destructive"
					onclick={(e) => {
						e.preventDefault();
						confirmRemoveKey();
					}}
				>
					Sil
				</AlertDialog.Action>
			</AlertDialog.Footer>
		{:else if deleteTargetId}
			<AlertDialog.Header>
				<AlertDialog.Title>"{deleteTargetLabel}" sağlayıcısı kaldırılsın mı?</AlertDialog.Title>
				<AlertDialog.Description>
					Bu sağlayıcı ve kayıtlı API anahtarı kalıcı olarak silinecek. Görev zincirlerinden de çıkarılır.
				</AlertDialog.Description>
			</AlertDialog.Header>
			<AlertDialog.Footer>
				<AlertDialog.Cancel>Vazgeç</AlertDialog.Cancel>
				<AlertDialog.Action
					variant="destructive"
					onclick={(e) => {
						e.preventDefault();
						if (deleteTargetId) deleteProvider(deleteTargetId);
					}}
				>
					Kaldır
				</AlertDialog.Action>
			</AlertDialog.Footer>
		{/if}
	</AlertDialog.Content>
</AlertDialog.Root>
