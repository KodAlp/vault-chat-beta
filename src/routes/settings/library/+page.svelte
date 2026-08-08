<script lang="ts">
	import { onMount } from 'svelte';
	import ImportObsidianDialog from '$lib/components/ImportObsidianDialog.svelte';
	import LibraryTree from '$lib/components/LibraryTree.svelte';
	import type { LibrarySettings } from '$lib/types';
	import { Switch } from '$lib/components/ui/switch';
	import { Input } from '$lib/components/ui/input';
	import * as Card from '$lib/components/ui/card';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';

	let settings = $state<LibrarySettings>({ keepOriginals: false, allowedLanguages: ['Türkçe'] });
	let allowedLanguagesInput = $state('Türkçe');
	let loadError = $state('');

	onMount(async () => {
		try {
			const res = await fetch('/api/library/settings');
			if (!res.ok) throw new Error();
			settings = (await res.json()) as LibrarySettings;
			allowedLanguagesInput = settings.allowedLanguages.join(', ');
		} catch {
			loadError = 'Ayarlar alınamadı.';
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
			loadError = 'Ayarlar kaydedilemedi.';
		}
	}

	function persistAllowedLanguages() {
		const parsed = allowedLanguagesInput
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean);
		settings.allowedLanguages = parsed.length ? parsed : ['Türkçe'];
		void persist();
	}
</script>

<svelte:head>
	<title>Kütüphane — Vault Agent Toolkit</title>
</svelte:head>

<div class="mx-auto max-w-2xl px-4 pt-6 pb-12">
	<div class="mb-6 flex items-baseline gap-4">
		<a href="/settings" class="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-[var(--accent)] focus-visible:outline-offset-2">
			<ArrowLeftIcon size={14} aria-hidden="true" /> Ayarlar
		</a>
		<h1 class="font-display text-xl font-medium">Kütüphane</h1>
	</div>

	{#if loadError}
		<p class="mb-4 text-sm text-destructive" role="alert">{loadError}</p>
	{/if}

	<Card.Root class="mb-6">
		<Card.Header>
			<Card.Title>Obsidian'dan İçe Aktar</Card.Title>
			<Card.Description>
				Bir Obsidian vault'unu tek yönlü kopyalar (kaynağa asla yazılmaz). Wikilink'ler göreli
				markdown linklerine çevrilir, eklerin kopyaları alınır, eksik frontmatter alanları
				varsayılan değer + gözden geçirme rozeti alır.
			</Card.Description>
		</Card.Header>
		<Card.Content>
			<ImportObsidianDialog />
		</Card.Content>
	</Card.Root>

	<Card.Root class="mb-6">
		<Card.Header>
			<Card.Title>Yükleme Ayarları</Card.Title>
		</Card.Header>
		<Card.Content class="flex flex-col gap-4">
			<label class="flex cursor-pointer items-center gap-2 text-sm">
				<Switch bind:checked={settings.keepOriginals} onCheckedChange={persist} />
				Dönüştürülen belgelerin orijinal dosyalarını sakla ({'data/library/_meta/originals/'})
			</label>
			<label class="flex flex-col gap-1 text-sm">
				Sohbette izinli diller
				<Input
					type="text"
					bind:value={allowedLanguagesInput}
					onchange={persistAllowedLanguages}
					placeholder="Türkçe, Korece"
				/>
				<span class="text-xs text-muted-foreground">
					İlk dil modelin birincil yanıt dili olur. Ek diller (dil öğrenme vault'ları gibi)
					yanıt içinde kullanılabilir ve sızıntı algılayıcı tarafından bozukluk sayılmaz.
				</span>
			</label>
		</Card.Content>
	</Card.Root>

	<Card.Root>
		<Card.Header>
			<Card.Title>Kütüphane Ağacı</Card.Title>
			<Card.Description>
				Belge yükle, yeniden adlandır veya sil. Sohbet ekranındaki kaynak ağacı (Faz 9) bunun
				yerine kapsam seçimi için ayrı, salt-görüntüleme bir kopyasını kullanır.
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
