<script lang="ts">
	import { onMount } from 'svelte';
	import { settings, persistSettings } from '$lib/settings.svelte';
	import type { OllamaModel } from '$lib/types';

	let models = $state<OllamaModel[]>([]);
	let loadError = $state('');

	onMount(async () => {
		try {
			const res = await fetch('/api/models');
			if (!res.ok) throw new Error();
			models = (await res.json()) as OllamaModel[];
		} catch {
			loadError = 'Model listesi alınamadı — Ollama çalışıyor mu?';
		}
	});
</script>

<svelte:head>
	<title>Ayarlar — Vault Chat</title>
</svelte:head>

<div class="settings">
	<header>
		<a href="/">← Ana sayfa</a>
		<h1>Ayarlar</h1>
	</header>

	<section>
		<h2>Tema</h2>
		<div class="theme-options">
			<label>
				<input type="radio" name="theme" value="system" bind:group={settings.theme} onchange={persistSettings} />
				Sistem
			</label>
			<label>
				<input type="radio" name="theme" value="light" bind:group={settings.theme} onchange={persistSettings} />
				Açık
			</label>
			<label>
				<input type="radio" name="theme" value="dark" bind:group={settings.theme} onchange={persistSettings} />
				Koyu
			</label>
		</div>
	</section>

	<section>
		<h2>Modeller</h2>
		{#if loadError}
			<p class="warn">{loadError}</p>
		{/if}

		<label class="field">
			Varsayılan model
			<span class="hint">Başlık üretimi gibi arka plan işleri için</span>
			<select bind:value={settings.defaultModel} onchange={persistSettings}>
				{#if models.length === 0}
					<option value={settings.defaultModel}>{settings.defaultModel}</option>
				{/if}
				{#each models as m (m.name)}
					<option value={m.name}>{m.name}</option>
				{/each}
			</select>
		</label>

		<label class="field">
			Hızlı model
			<span class="hint">"Derin düşün" kapalıyken kullanılır</span>
			<select bind:value={settings.fastModel} onchange={persistSettings}>
				{#if models.length === 0}
					<option value={settings.fastModel}>{settings.fastModel}</option>
				{/if}
				{#each models as m (m.name)}
					<option value={m.name}>{m.name}</option>
				{/each}
			</select>
		</label>

		<label class="field">
			Muhakeme modeli
			<span class="hint">"Derin düşün" açıkken kullanılır</span>
			<select bind:value={settings.reasoningModel} onchange={persistSettings}>
				{#if models.length === 0}
					<option value={settings.reasoningModel}>{settings.reasoningModel}</option>
				{/if}
				{#each models as m (m.name)}
					<option value={m.name}>{m.name}</option>
				{/each}
			</select>
		</label>
	</section>

	<section>
		<h2>Kütüphane</h2>
		<p class="hint">Obsidian vault'undan içe aktar, belge yükleme ayarları.</p>
		<a class="skills-link" href="/settings/library">Kütüphaneyi yönet →</a>
	</section>

	<section>
		<h2>Kullanıcı Skill'leri</h2>
		<p class="hint">Sohbet, test ve bilgi kartı üretimini kişiselleştir.</p>
		<a class="skills-link" href="/settings/skills">Skill'leri yönet →</a>
	</section>

	<section class="placeholder">
		<h2>Model indirme &amp; API bağlantıları</h2>
		<p>Yakında (Faz 6).</p>
	</section>
</div>

<style>
	.settings {
		max-width: 640px;
		margin: 0 auto;
		padding: 1.5rem 1rem 3rem;
	}

	header {
		display: flex;
		align-items: baseline;
		gap: 1rem;
		margin-bottom: 2rem;
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

	section.placeholder {
		color: var(--muted);
		border-bottom: none;
	}

	.theme-options {
		display: flex;
		gap: 1.25rem;
	}

	.theme-options label {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		cursor: pointer;
	}

	.field {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		margin-bottom: 1rem;
		font-size: 0.9rem;
	}

	.hint {
		font-size: 0.75rem;
		color: var(--muted);
	}

	select {
		background: var(--bg);
		color: var(--fg);
		border: 1px solid var(--border);
		border-radius: 6px;
		padding: 0.4rem 0.5rem;
		font-size: 0.9rem;
		max-width: 320px;
	}

	.warn {
		color: var(--error);
		font-size: 0.85rem;
	}

	.skills-link {
		font-size: 0.9rem;
		color: var(--accent);
		text-decoration: none;
		font-weight: 600;
	}
</style>
