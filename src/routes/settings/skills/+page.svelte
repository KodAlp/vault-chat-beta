<script lang="ts">
	import { onMount } from 'svelte';
	import type { UserSkillStatus, UserSkillScope } from '$lib/types';

	const SCOPE_LABELS: Record<UserSkillScope, string> = {
		chat: 'Sohbet',
		quiz: 'Test',
		flashcards: 'Kartlar',
		mindmap: 'Zihin haritası',
		report: 'Rapor',
		slides: 'Slayt'
	};

	const TEMPLATE = `---
description: Bu skill ne yapar? (zorunlu)
scope: all
enabled: true
priority: 50
---
Kurallar, tercihler, yasaklar... serbest markdown.
`;

	let skills = $state<UserSkillStatus[]>([]);
	let loadError = $state('');

	let editorOpen = $state(false);
	let editorName = $state('');
	let editorIsNew = $state(false);
	let editorRaw = $state('');
	let editorError = $state('');
	let editorSaving = $state(false);

	let previewScope = $state<UserSkillScope>('chat');
	let previewText = $state('');
	let previewLoading = $state(false);
	let previewOpen = $state(false);

	async function refresh() {
		try {
			const res = await fetch('/api/skills');
			if (!res.ok) throw new Error();
			skills = ((await res.json()) as { skills: UserSkillStatus[] }).skills;
		} catch {
			loadError = 'Skill listesi alınamadı.';
		}
	}

	onMount(refresh);

	function scopeChips(scope: UserSkillStatus['scope']): string[] {
		return scope === 'all' ? ['Tümü'] : scope.map((s) => SCOPE_LABELS[s]);
	}

	function budgetClass(charCount: number): string {
		const pct = charCount / 4000;
		if (pct >= 1) return 'red';
		if (pct >= 0.7) return 'amber';
		return 'green';
	}

	async function toggleEnabled(skill: UserSkillStatus) {
		try {
			const res = await fetch(`/api/skills/${encodeURIComponent(skill.name)}`, {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ enabled: !skill.enabled })
			});
			if (!res.ok) throw new Error();
			await refresh();
		} catch {
			loadError = `"${skill.name}" güncellenemedi.`;
		}
	}

	async function changePriority(skill: UserSkillStatus, value: number) {
		try {
			const res = await fetch(`/api/skills/${encodeURIComponent(skill.name)}`, {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ priority: value })
			});
			if (!res.ok) throw new Error();
			await refresh();
		} catch {
			loadError = `"${skill.name}" güncellenemedi.`;
		}
	}

	async function openEditor(skill: UserSkillStatus) {
		editorError = '';
		try {
			const res = await fetch(`/api/skills/${encodeURIComponent(skill.name)}`);
			if (!res.ok) throw new Error();
			const data = (await res.json()) as { name: string; raw: string };
			editorName = data.name;
			editorRaw = data.raw;
			editorIsNew = false;
			editorOpen = true;
		} catch {
			loadError = `"${skill.name}" yüklenemedi.`;
		}
	}

	function openNewEditor() {
		editorError = '';
		editorName = '';
		editorRaw = TEMPLATE;
		editorIsNew = true;
		editorOpen = true;
	}

	function closeEditor() {
		editorOpen = false;
	}

	async function saveEditor() {
		const name = editorName.trim();
		if (!name) {
			editorError = 'İsim gerekli.';
			return;
		}
		editorSaving = true;
		editorError = '';
		try {
			const res = await fetch(`/api/skills/${encodeURIComponent(name)}`, {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ raw: editorRaw })
			});
			if (!res.ok) {
				const body = (await res.json().catch(() => null)) as { message?: string } | null;
				editorError = body?.message ?? 'Kaydedilemedi.';
				return;
			}
			editorOpen = false;
			await refresh();
		} catch {
			editorError = 'Kaydedilemedi.';
		} finally {
			editorSaving = false;
		}
	}

	async function removeSkill(skill: UserSkillStatus) {
		if (!confirm(`"${skill.name}" silinsin mi?`)) return;
		try {
			const res = await fetch(`/api/skills/${encodeURIComponent(skill.name)}`, { method: 'DELETE' });
			if (!res.ok) throw new Error();
			await refresh();
		} catch {
			loadError = `"${skill.name}" silinemedi.`;
		}
	}

	async function runPreview() {
		previewLoading = true;
		previewOpen = true;
		try {
			const res = await fetch(`/api/skills/preview?scope=${previewScope}`);
			if (!res.ok) throw new Error();
			previewText = ((await res.json()) as { prompt: string }).prompt;
		} catch {
			previewText = 'Önizleme alınamadı.';
		} finally {
			previewLoading = false;
		}
	}
</script>

<svelte:head>
	<title>Kullanıcı Skill'leri — Vault Chat</title>
</svelte:head>

<div class="skills-page">
	<header>
		<a href="/settings">← Ayarlar</a>
		<h1>Kullanıcı Skill'leri</h1>
	</header>

	<p class="hint">
		<code>data/skills/</code> içine bıraktığın markdown dosyaları sohbet, test ve bilgi kartı
		üretimini özelleştirir. Matematik biçimi ve kaynak doğrulama kuralları her zaman en son
		uygulanır — bir skill bunları geçersiz kılamaz.
	</p>

	{#if loadError}
		<p class="warn">{loadError}</p>
	{/if}

	<div class="toolbar">
		<button class="primary" onclick={openNewEditor}>+ Yeni skill</button>
		<div class="preview-controls">
			<select bind:value={previewScope}>
				<option value="chat">Sohbet</option>
				<option value="quiz">Test</option>
				<option value="flashcards">Kartlar</option>
				<option value="report">Rapor</option>
				<option value="mindmap">Zihin haritası</option>
				<option value="slides">Slayt</option>
			</select>
			<button onclick={runPreview}>Önizleme</button>
		</div>
	</div>

	<div class="list">
		{#each skills as skill (skill.relPath)}
			<div class="row">
				<div class="main">
					<div class="title-line">
						<strong>{skill.name}</strong>
						{#each scopeChips(skill.scope) as chip (chip)}
							<span class="chip">{chip}</span>
						{/each}
						{#if skill.parseError}
							<span class="badge error" title={skill.parseError}>hata</span>
						{/if}
						{#if skill.truncated}
							<span class="badge warn-badge">kısaltıldı</span>
						{/if}
					</div>
					<p class="description">{skill.description ?? skill.relPath}</p>
					<div class="budget-bar">
						<div
							class="budget-fill {budgetClass(skill.charCount)}"
							style="width: {Math.min(100, (skill.charCount / 4000) * 100)}%"
						></div>
					</div>
					<span class="char-count">{skill.charCount} / 4000</span>
				</div>

				<div class="controls">
					<label class="toggle">
						<input
							type="checkbox"
							checked={skill.enabled}
							onchange={() => toggleEnabled(skill)}
						/>
						Etkin
					</label>
					<label class="priority">
						Öncelik
						<input
							type="number"
							min="0"
							max="100"
							value={skill.priority}
							onchange={(e) => changePriority(skill, Number(e.currentTarget.value))}
						/>
					</label>
					<button onclick={() => openEditor(skill)}>Düzenle</button>
					<button class="danger" onclick={() => removeSkill(skill)}>Sil</button>
				</div>
			</div>
		{:else}
			<p class="hint">Henüz skill yok. "_examples/" klasöründeki örnekler devre dışı olarak
				geldi — düzenleyip etkinleştirebilirsin.</p>
		{/each}
	</div>
</div>

{#if editorOpen}
	<div class="overlay" onclick={closeEditor} onkeydown={(e) => e.key === 'Escape' && closeEditor()} role="presentation">
		<div class="dialog" onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.stopPropagation()} role="dialog" aria-modal="true" tabindex="-1">
			<h2>{editorIsNew ? 'Yeni skill' : editorName}</h2>

			{#if editorIsNew}
				<label class="field">
					İsim (kebab-case)
					<input type="text" bind:value={editorName} placeholder="örn. math-notation" />
				</label>
			{/if}

			<label class="field">
				İçerik (frontmatter + markdown)
				<textarea class="raw-editor" bind:value={editorRaw} spellcheck="false"></textarea>
			</label>

			{#if editorError}
				<p class="warn">{editorError}</p>
			{/if}

			<div class="actions">
				<button onclick={closeEditor}>İptal</button>
				<button class="primary" onclick={saveEditor} disabled={editorSaving}>
					{editorSaving ? 'Kaydediliyor...' : 'Kaydet'}
				</button>
			</div>
		</div>
	</div>
{/if}

{#if previewOpen}
	<div class="overlay" onclick={() => (previewOpen = false)} onkeydown={(e) => e.key === 'Escape' && (previewOpen = false)} role="presentation">
		<div class="dialog wide" onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.stopPropagation()} role="dialog" aria-modal="true" tabindex="-1">
			<h2>Önizleme — {SCOPE_LABELS[previewScope]}</h2>
			{#if previewLoading}
				<p class="hint">Yükleniyor...</p>
			{:else}
				<pre class="preview-text">{previewText}</pre>
			{/if}
			<div class="actions">
				<button onclick={() => (previewOpen = false)}>Kapat</button>
			</div>
		</div>
	</div>
{/if}

<style>
	.skills-page {
		max-width: 760px;
		margin: 0 auto;
		padding: 1.5rem 1rem 3rem;
	}

	header {
		display: flex;
		align-items: baseline;
		gap: 1rem;
		margin-bottom: 0.75rem;
	}

	header a {
		font-size: 0.9rem;
		text-decoration: none;
	}

	h1 {
		font-size: 1.3rem;
		margin: 0;
	}

	.hint {
		font-size: 0.85rem;
		color: var(--muted);
		margin-bottom: 1.25rem;
	}

	.warn {
		color: var(--error);
		font-size: 0.85rem;
	}

	.toolbar {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 1.25rem;
		gap: 1rem;
	}

	.preview-controls {
		display: flex;
		gap: 0.5rem;
	}

	.list {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.row {
		border: 1px solid var(--border);
		border-radius: 10px;
		padding: 0.9rem 1rem;
		display: flex;
		justify-content: space-between;
		gap: 1rem;
		flex-wrap: wrap;
	}

	.main {
		flex: 1;
		min-width: 220px;
	}

	.title-line {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		flex-wrap: wrap;
	}

	.chip {
		font-size: 0.7rem;
		border: 1px solid var(--border);
		border-radius: 999px;
		padding: 0.1rem 0.5rem;
		color: var(--muted);
	}

	.badge {
		font-size: 0.7rem;
		border-radius: 999px;
		padding: 0.1rem 0.5rem;
	}

	.badge.error {
		background: color-mix(in srgb, var(--error) 15%, transparent);
		color: var(--error);
	}

	.badge.warn-badge {
		background: color-mix(in srgb, orange 20%, transparent);
		color: #b8860b;
	}

	.description {
		font-size: 0.85rem;
		color: var(--muted);
		margin: 0.3rem 0 0.5rem;
	}

	.budget-bar {
		height: 4px;
		background: var(--border);
		border-radius: 999px;
		overflow: hidden;
		width: 160px;
	}

	.budget-fill {
		height: 100%;
	}

	.budget-fill.green {
		background: #2e7d32;
	}

	.budget-fill.amber {
		background: #b8860b;
	}

	.budget-fill.red {
		background: var(--error);
	}

	.char-count {
		font-size: 0.7rem;
		color: var(--muted);
	}

	.controls {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		flex-wrap: wrap;
	}

	.toggle {
		display: flex;
		align-items: center;
		gap: 0.3rem;
		font-size: 0.8rem;
		cursor: pointer;
	}

	.priority {
		display: flex;
		align-items: center;
		gap: 0.3rem;
		font-size: 0.8rem;
	}

	.priority input {
		width: 3.5rem;
	}

	.controls button {
		padding: 0.35rem 0.7rem;
		border-radius: 6px;
		border: 1px solid var(--border);
		background: transparent;
		color: var(--fg);
		cursor: pointer;
		font-size: 0.8rem;
	}

	.controls button.danger {
		color: var(--error);
		border-color: var(--error);
	}

	select,
	input[type='text'],
	input[type='number'] {
		background: var(--bg);
		color: var(--fg);
		border: 1px solid var(--border);
		border-radius: 6px;
		padding: 0.35rem 0.5rem;
		font-family: var(--font-sans);
		font-size: 0.85rem;
	}

	button.primary {
		background: var(--accent);
		color: var(--accent-fg);
		border-color: var(--accent);
		font-weight: 600;
	}

	.overlay {
		position: fixed;
		inset: 0;
		background: rgb(0 0 0 / 0.4);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 100;
	}

	.dialog {
		background: var(--bg);
		color: var(--fg);
		border: 1px solid var(--border);
		border-radius: 12px;
		padding: 1.25rem;
		width: min(560px, 90vw);
		max-height: 85vh;
		overflow-y: auto;
		box-shadow: 0 8px 24px rgb(0 0 0 / 0.25);
	}

	.dialog.wide {
		width: min(720px, 92vw);
	}

	.dialog h2 {
		margin: 0 0 1rem;
		font-size: 1.1rem;
	}

	.field {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		font-size: 0.85rem;
		margin-bottom: 0.9rem;
	}

	.raw-editor {
		width: 100%;
		min-height: 16rem;
		resize: vertical;
		font-family: ui-monospace, 'SF Mono', Consolas, monospace;
		font-size: 0.82rem;
		line-height: 1.5;
		background: var(--bg);
		color: var(--fg);
		border: 1px solid var(--border);
		border-radius: 6px;
		padding: 0.6rem 0.7rem;
	}

	.preview-text {
		white-space: pre-wrap;
		font-family: ui-monospace, 'SF Mono', Consolas, monospace;
		font-size: 0.8rem;
		line-height: 1.5;
		max-height: 60vh;
		overflow-y: auto;
		background: var(--bubble-assistant);
		border-radius: 8px;
		padding: 0.9rem;
	}

	.actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
		margin-top: 1rem;
	}

	.actions button {
		padding: 0.45rem 1rem;
		border-radius: 8px;
		border: 1px solid var(--border);
		background: transparent;
		color: var(--fg);
		cursor: pointer;
		font-size: 0.9rem;
	}

	.actions button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
</style>
