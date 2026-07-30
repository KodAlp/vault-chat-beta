<script lang="ts">
	import { onMount } from 'svelte';
	import ImportObsidianDialog from '$lib/components/ImportObsidianDialog.svelte';
	import type { LibrarySettings } from '$lib/types';

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

<div class="library-settings">
	<header>
		<a href="/settings">← Ayarlar</a>
		<h1>Kütüphane</h1>
	</header>

	{#if loadError}
		<p class="warn">{loadError}</p>
	{/if}

	<section>
		<h2>Obsidian'dan İçe Aktar</h2>
		<p class="hint">
			Bir Obsidian vault'unu tek yönlü kopyalar (kaynağa asla yazılmaz). Wikilink'ler göreli
			markdown linklerine çevrilir, eklerin kopyaları alınır, eksik frontmatter alanları
			varsayılan değer + gözden geçirme rozeti alır.
		</p>
		<ImportObsidianDialog />
	</section>

	<section>
		<h2>Yükleme Ayarları</h2>
		<label class="checkbox-field">
			<input type="checkbox" bind:checked={settings.keepOriginals} onchange={persist} />
			Dönüştürülen belgelerin orijinal dosyalarını sakla ({'data/library/_meta/originals/'})
		</label>
	</section>
</div>

<style>
	.library-settings {
		max-width: 640px;
		margin: 0 auto;
		padding: 1.5rem 1rem 3rem;
	}

	header {
		display: flex;
		align-items: baseline;
		gap: 1rem;
		margin-bottom: 1.5rem;
	}

	header a {
		font-size: 0.9rem;
		text-decoration: none;
	}

	h1 {
		font-size: 1.3rem;
		margin: 0;
	}

	h2 {
		font-size: 1rem;
		margin: 0 0 0.75rem;
	}

	section {
		margin-bottom: 2rem;
		padding-bottom: 1.5rem;
		border-bottom: 1px solid var(--border);
	}

	.hint {
		font-size: 0.85rem;
		color: var(--muted-foreground);
		margin-bottom: 1rem;
	}

	.checkbox-field {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		font-size: 0.85rem;
		cursor: pointer;
	}

	.warn {
		color: var(--destructive);
		font-size: 0.85rem;
	}
</style>
