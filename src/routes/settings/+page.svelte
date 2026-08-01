<script lang="ts">
	import { onMount } from 'svelte';
	import { settings, persistSettings } from '$lib/settings.svelte';
	import type { OllamaModel } from '$lib/types';
	import { isTauri, invoke } from '@tauri-apps/api/core';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import * as Select from '$lib/components/ui/select';
	import * as Card from '$lib/components/ui/card';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import ArrowRightIcon from '@lucide/svelte/icons/arrow-right';

	let models = $state<OllamaModel[]>([]);
	let loadError = $state('');

	const runningInTauri = isTauri();
	let vaultPath = $state('');
	let vaultName = $state('');
	let vaultSaveStatus = $state<'idle' | 'saved' | 'error'>('idle');

	onMount(async () => {
		try {
			const res = await fetch('/api/models');
			if (!res.ok) throw new Error();
			models = (await res.json()) as OllamaModel[];
		} catch {
			loadError = 'Model listesi alınamadı — Ollama çalışıyor mu?';
		}

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

			<div class="flex flex-col gap-1.5">
				<Label>Varsayılan model</Label>
				<span class="text-xs text-muted-foreground">Başlık üretimi gibi arka plan işleri için</span>
				<Select.Root type="single" bind:value={settings.defaultModel} onValueChange={persistSettings}>
					<Select.Trigger class="max-w-xs">{settings.defaultModel}</Select.Trigger>
					<Select.Content>
						{#each models as m (m.name)}
							<Select.Item value={m.name} label={m.name}>{m.name}</Select.Item>
						{/each}
					</Select.Content>
				</Select.Root>
			</div>

			<div class="flex flex-col gap-1.5">
				<Label>Hızlı model</Label>
				<span class="text-xs text-muted-foreground">"Derin düşün" kapalıyken kullanılır</span>
				<Select.Root type="single" bind:value={settings.fastModel} onValueChange={persistSettings}>
					<Select.Trigger class="max-w-xs">{settings.fastModel}</Select.Trigger>
					<Select.Content>
						{#each models as m (m.name)}
							<Select.Item value={m.name} label={m.name}>{m.name}</Select.Item>
						{/each}
					</Select.Content>
				</Select.Root>
			</div>

			<div class="flex flex-col gap-1.5">
				<Label>Muhakeme modeli</Label>
				<span class="text-xs text-muted-foreground">"Derin düşün" açıkken kullanılır</span>
				<Select.Root type="single" bind:value={settings.reasoningModel} onValueChange={persistSettings}>
					<Select.Trigger class="max-w-xs">{settings.reasoningModel}</Select.Trigger>
					<Select.Content>
						{#each models as m (m.name)}
							<Select.Item value={m.name} label={m.name}>{m.name}</Select.Item>
						{/each}
					</Select.Content>
				</Select.Root>
			</div>
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
