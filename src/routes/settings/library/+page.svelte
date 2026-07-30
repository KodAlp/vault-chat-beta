<script lang="ts">
	import { onMount } from 'svelte';
	import ImportObsidianDialog from '$lib/components/ImportObsidianDialog.svelte';
	import type { LibrarySettings } from '$lib/types';
	import { Switch } from '$lib/components/ui/switch';
	import * as Card from '$lib/components/ui/card';

	let settings = $state<LibrarySettings>({ keepOriginals: false });
	let loadError = $state('');

	onMount(async () => {
		try {
			const res = await fetch('/api/library/settings');
			if (!res.ok) throw new Error();
			settings = (await res.json()) as LibrarySettings;
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
</script>

<svelte:head>
	<title>Kütüphane — Vault Chat</title>
</svelte:head>

<div class="mx-auto max-w-2xl px-4 pt-6 pb-12">
	<div class="mb-6 flex items-baseline gap-4">
		<a href="/settings" class="text-sm text-muted-foreground hover:text-foreground">← Ayarlar</a>
		<h1 class="text-xl font-semibold">Kütüphane</h1>
	</div>

	{#if loadError}
		<p class="mb-4 text-sm text-destructive">{loadError}</p>
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

	<Card.Root>
		<Card.Header>
			<Card.Title>Yükleme Ayarları</Card.Title>
		</Card.Header>
		<Card.Content>
			<label class="flex cursor-pointer items-center gap-2 text-sm">
				<Switch bind:checked={settings.keepOriginals} onCheckedChange={persist} />
				Dönüştürülen belgelerin orijinal dosyalarını sakla ({'data/library/_meta/originals/'})
			</label>
		</Card.Content>
	</Card.Root>
</div>
