<script lang="ts">
	import { onMount } from 'svelte';
	import { settings, persistSettings } from '$lib/settings.svelte';
	import type { OllamaModel, ProviderModelOption } from '$lib/types';
	import { isTauri, invoke } from '@tauri-apps/api/core';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { Switch } from '$lib/components/ui/switch';
	import * as Select from '$lib/components/ui/select';
	import * as Card from '$lib/components/ui/card';
	import * as AlertDialog from '$lib/components/ui/alert-dialog';
	import { Separator } from '$lib/components/ui/separator';
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
			loadError = 'Model listesi alınamadı — Ollama çalışıyor mu?';
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
			providerModelsError = 'Sağlayıcı modelleri alınamadı.';
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

	// U+241F (Unit Separator) — a plain model id could collide across two
	// providers (nothing stops two OpenAI-compatible endpoints from both
	// serving a model literally called "gpt-4o"), so Select.Root's single
	// string `value` has to carry providerId+modelId together, not just the
	// id. Never appears in a real provider/model id, so plain split() is safe.
	function selectionKey(providerId: string, modelId: string): string {
		return `${providerId}␟${modelId}`;
	}

	function parseSelectionKey(key: string): { providerId: string; modelId: string } {
		const [providerId, modelId] = key.split('␟');
		return { providerId, modelId };
	}

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
		pullStatus = 'Başlatılıyor...';
		pullError = '';
		try {
			const res = await fetch('/api/models', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ model: name })
			});
			if (!res.ok || !res.body) throw new Error(`İstek başarısız (${res.status})`);
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
					if (event.type === 'progress') pullStatus = event.status ?? 'İndiriliyor...';
					else if (event.type === 'done') {
						pullStatus = 'Tamamlandı';
						pullName = '';
						await refreshModels();
					} else if (event.type === 'error') {
						pullError = event.error ?? 'İndirme başarısız';
						pullStatus = '';
					}
				}
			}
		} catch (err) {
			pullError = err instanceof Error ? err.message : 'İndirme başarısız';
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
			deleteError = `"${m.name}" silinemedi.`;
		} finally {
			deleting = false;
		}
	}

	const runningInTauri = isTauri();
	let vaultPath = $state('');
	let vaultName = $state('');
	let vaultSaveStatus = $state<'idle' | 'saved' | 'error'>('idle');

	onMount(async () => {
		await Promise.all([refreshModels(), refreshProviderModels()]);

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

	const themeOptions = [
		{ value: 'system', label: 'Sistem' },
		{ value: 'light', label: 'Açık' },
		{ value: 'dark', label: 'Koyu' }
	] as const;
</script>

<svelte:head>
	<title>Ayarlar — Vault Agent Toolkit</title>
</svelte:head>

<div class="mx-auto max-w-2xl px-4 pt-6 pb-12">
	<div class="mb-8 flex items-baseline gap-4">
		<a href="/" class="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-[var(--accent)] focus-visible:outline-offset-2">
			<ArrowLeftIcon size={14} aria-hidden="true" /> Ana sayfa
		</a>
		<h1 class="font-display text-xl font-medium">Ayarlar</h1>
	</div>

	<Card.Root class="mb-6">
		<Card.Header>
			<Card.Title>Tema</Card.Title>
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
			<Card.Title>Modeller</Card.Title>
		</Card.Header>
		<Card.Content class="flex flex-col gap-4">
			{#if loadError}
				<p class="text-sm text-destructive" role="alert">{loadError}</p>
			{/if}
			{#if providerModelsError}
				<p class="text-sm text-destructive" role="alert">{providerModelsError}</p>
			{/if}

			<div class="flex flex-col gap-1.5">
				<Label>Varsayılan model</Label>
				<span class="text-xs text-muted-foreground">Başlık üretimi gibi arka plan işleri için</span>
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
				<Label>Hızlı model</Label>
				<span class="text-xs text-muted-foreground">"Derin düşün" kapalıyken kullanılır</span>
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
				<Label>Muhakeme modeli</Label>
				<span class="text-xs text-muted-foreground">"Derin düşün" açıkken kullanılır</span>
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
				<Label>Kurulu modeller</Label>
				<span class="text-xs text-muted-foreground">Ollama'da yüklü modeller. Yeni model indirmek için aşağıdaki alanı kullan.</span>
				{#if models.length === 0}
					<p class="text-sm text-muted-foreground">Kurulu model yok.</p>
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
									title="Modeli sil"
									aria-label={`${m.name} modelini sil`}
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
				<Label>Model indir</Label>
				<span class="text-xs text-muted-foreground">Ollama kütüphanesinden bir model çek (örn. <code class="rounded bg-muted px-1 text-xs">qwen3:8b</code>, <code class="rounded bg-muted px-1 text-xs">llama3.2</code>).</span>
				<div class="flex gap-2">
					<Input
						type="text"
						bind:value={pullName}
						placeholder="model adı (örn. qwen3:8b)"
						class="max-w-xs"
						disabled={pulling}
						onkeydown={(e) => e.key === 'Enter' && pullModel()}
					/>
					<Button type="button" onclick={pullModel} disabled={!pullName.trim() || pulling}>
						<DownloadIcon size={14} aria-hidden="true" /> {pulling ? 'İndiriliyor...' : 'İndir'}
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
			<Card.Title>Üretim</Card.Title>
		</Card.Header>
		<Card.Content>
			<label class="flex cursor-pointer items-start gap-2.5 text-sm">
				<Switch bind:checked={settings.allowConcurrentGeneration} onCheckedChange={persistSettings} />
				<span class="flex flex-col gap-0.5">
					Aynı anda birden fazla üretime izin ver
					<span class="text-xs text-muted-foreground">
						Varsayılan olarak kapalı — test/kart/rapor/harita/slayt üretimi aynı türden yeni bir
						üretim başlatılmadan önce mevcut üretimin bitmesini bekler (zayıf donanımda hepsi
						birbirini yavaşlatmasın diye). Donanımınız yeterliyse açabilirsiniz.
					</span>
				</span>
			</label>
		</Card.Content>
	</Card.Root>

	{#if runningInTauri}
		<Card.Root class="mb-6">
			<Card.Header>
				<Card.Title>Masaüstü — Kasa Konumu</Card.Title>
				<Card.Description>
					Değişiklik bir sonraki uygulama başlatmasında etkili olur (sunucu şu an çalışırken kasa
					yolu değiştirilemez).
				</Card.Description>
			</Card.Header>
			<Card.Content class="flex flex-col gap-4">
				<div class="flex flex-col gap-1.5">
					<Label>Kasa klasörü</Label>
					<div class="flex gap-2">
						<Input type="text" readonly value={vaultPath} placeholder="Henüz seçilmedi" class="flex-1" />
						<Button type="button" variant="outline" onclick={pickVaultFolder}>Seç…</Button>
					</div>
				</div>
				<div class="flex flex-col gap-1.5">
					<Label>Obsidian'da görünen vault adı</Label>
					<Input type="text" bind:value={vaultName} class="max-w-xs" />
				</div>
				<div>
					<Button type="button" onclick={saveVaultConfig}>Kaydet</Button>
					{#if vaultSaveStatus === 'saved'}
						<span class="ml-2 text-sm text-[var(--success)]"
							>Kaydedildi — bir sonraki başlatmada uygulanır.</span
						>
					{:else if vaultSaveStatus === 'error'}
						<span class="ml-2 text-sm text-destructive" role="alert">Kaydedilemedi.</span>
					{/if}
				</div>
			</Card.Content>
		</Card.Root>
	{/if}

	<Card.Root class="mb-6">
		<Card.Header>
			<Card.Title>Vault'lar</Card.Title>
			<Card.Description>Birden fazla kütüphane arasında geçiş yap, yeni vault oluştur veya sil.</Card.Description>
		</Card.Header>
		<Card.Content>
			<a href="/settings/vaults" class="flex items-center gap-1 text-sm font-semibold text-primary hover:underline">
				Vault'ları yönet <ArrowRightIcon size={14} aria-hidden="true" />
			</a>
		</Card.Content>
	</Card.Root>

	<Card.Root class="mb-6">
		<Card.Header>
			<Card.Title>Kütüphane</Card.Title>
			<Card.Description>Obsidian vault'undan içe aktar, belge yükleme ayarları.</Card.Description>
		</Card.Header>
		<Card.Content>
			<a href="/settings/library" class="flex items-center gap-1 text-sm font-semibold text-primary hover:underline">
				Kütüphaneyi yönet <ArrowRightIcon size={14} aria-hidden="true" />
			</a>
		</Card.Content>
	</Card.Root>

	<Card.Root class="mb-6">
		<Card.Header>
			<Card.Title>Kullanıcı Skill'leri</Card.Title>
			<Card.Description>Sohbet, test ve bilgi kartı üretimini kişiselleştir.</Card.Description>
		</Card.Header>
		<Card.Content>
			<a href="/settings/skills" class="flex items-center gap-1 text-sm font-semibold text-primary hover:underline">
				Skill'leri yönet <ArrowRightIcon size={14} aria-hidden="true" />
			</a>
		</Card.Content>
	</Card.Root>

	<Card.Root>
		<Card.Header>
			<Card.Title>Model Sağlayıcıları</Card.Title>
			<Card.Description>Ollama ve bulut sağlayıcıları (DeepSeek, ...), API anahtarları, görev zincirleri.</Card.Description>
		</Card.Header>
		<Card.Content>
			<a href="/settings/providers" class="flex items-center gap-1 text-sm font-semibold text-primary hover:underline">
				Sağlayıcıları yönet <ArrowRightIcon size={14} aria-hidden="true" />
			</a>
		</Card.Content>
	</Card.Root>
</div>

<AlertDialog.Root open={!!deleteTarget} onOpenChange={(open) => !open && (deleteTarget = null)}>
	<AlertDialog.Content>
		{#if deleteTarget}
			<AlertDialog.Header>
				<AlertDialog.Title>"{deleteTarget.name}" silinsin mi?</AlertDialog.Title>
				<AlertDialog.Description>
					Bu model Ollama'dan kalıcı olarak kaldırılacak. İndirme dosyaları diskten silinir.
				</AlertDialog.Description>
			</AlertDialog.Header>
			<AlertDialog.Footer>
				<AlertDialog.Cancel>Vazgeç</AlertDialog.Cancel>
				<AlertDialog.Action
					variant="destructive"
					onclick={(e) => {
						e.preventDefault();
						confirmDelete();
					}}
				>
					Sil
				</AlertDialog.Action>
			</AlertDialog.Footer>
		{/if}
	</AlertDialog.Content>
</AlertDialog.Root>
