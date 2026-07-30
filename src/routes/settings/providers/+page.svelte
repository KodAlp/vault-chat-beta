<script lang="ts">
	import { onMount } from 'svelte';
	import type { ProviderStatus } from '$lib/types';

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

	async function removeKey(p: ProviderStatus) {
		if (!confirm(`"${p.label}" anahtarı silinsin mi?`)) return;
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
	<title>Model Sağlayıcıları — Vault Chat</title>
</svelte:head>

<div class="providers-page">
	<header>
		<a href="/settings">← Ayarlar</a>
		<h1>Model Sağlayıcıları</h1>
	</header>

	<p class="hint">
		Yerel Ollama'yı ve isteğe bağlı bulut sağlayıcıları (DeepSeek, OpenAI, ...) yönet. Anahtarlar
		sunucuda <code>data/secrets.json</code> içinde kalır, hiçbir zaman tarayıcıya gönderilmez.
	</p>

	{#if loadError}
		<p class="warn">{loadError}</p>
	{/if}

	<section>
		<h2>Sağlayıcılar</h2>
		<div class="list">
			{#each providers as p (p.id)}
				<div class="row">
					<div class="main">
						<div class="title-line">
							<strong>{p.label}</strong>
							<span class="chip">{p.kind === 'ollama' ? 'yerel' : 'bulut'}</span>
							{#if p.needsKey}
								<span class="chip" class:connected={p.keyStatus === 'connected'}>
									{p.keyStatus === 'connected' ? `bağlı · ${p.mask}` : 'anahtar yok'}
								</span>
							{/if}
						</div>
						<p class="description">{p.baseUrl}</p>

						{#if keyEditingId === p.id}
							<div class="key-editor">
								<input
									type="password"
									placeholder="API anahtarı"
									bind:value={keyDrafts[p.id]}
									onkeydown={(e) => e.key === 'Enter' && saveKey(p)}
								/>
								<button class="primary" onclick={() => saveKey(p)}>Kaydet</button>
								<button onclick={() => (keyEditingId = null)}>İptal</button>
							</div>
						{/if}

						{#if testResults[p.id]}
							<p class="test-result">{TEST_LABELS[testResults[p.id]] ?? testResults[p.id]}</p>
						{/if}
					</div>

					<div class="controls">
						<label class="toggle">
							<input type="checkbox" checked={p.enabled} onchange={() => toggleEnabled(p)} />
							Etkin
						</label>
						{#if p.needsKey}
							<button onclick={() => openKeyEditor(p)}>
								{p.keyStatus === 'connected' ? 'Anahtarı değiştir' : 'Anahtar ekle'}
							</button>
							{#if p.keyStatus === 'connected'}
								<button class="danger" onclick={() => removeKey(p)}>Anahtarı sil</button>
							{/if}
						{/if}
						<button onclick={() => testConnection(p)} disabled={testingId === p.id}>
							{testingId === p.id ? 'Test ediliyor...' : 'Bağlantıyı test et'}
						</button>
					</div>
				</div>
			{/each}
		</div>
	</section>

	<section>
		<h2>Görev başına varsayılan zincir</h2>
		<p class="hint">
			Her görev tipi için sırayla denenecek sağlayıcılar. İlk sağlayıcı yanıt veremezse (ağ hatası,
			zaman aşımı) bir sonrakine geçilir — yanlış API anahtarı gibi kalıcı hatalarda geçiş yapılmaz.
		</p>
		{#each Object.keys(TASK_LABELS) as taskType (taskType)}
			<div class="chain-row">
				<span class="task-label">{TASK_LABELS[taskType]}</span>
				<div class="chain-items">
					{#each chains[taskType] ?? [] as providerId, i (providerId + i)}
						<span class="chain-chip">
							{labelFor(providerId)}
							<button
								class="icon-btn"
								title="Yukarı taşı"
								disabled={i === 0}
								onclick={() => moveInChain(taskType, i, -1)}>↑</button
							>
							<button
								class="icon-btn"
								title="Aşağı taşı"
								disabled={i === (chains[taskType]?.length ?? 0) - 1}
								onclick={() => moveInChain(taskType, i, 1)}>↓</button
							>
							<button class="icon-btn" title="Kaldır" onclick={() => removeFromChain(taskType, i)}
								>×</button
							>
						</span>
					{:else}
						<span class="hint">zincir boş</span>
					{/each}
				</div>
				{#if availableToAdd(taskType).length > 0}
					<div class="chain-add">
						<select bind:value={addChainSelection[taskType]}>
							<option value="">sağlayıcı ekle...</option>
							{#each availableToAdd(taskType) as p (p.id)}
								<option value={p.id}>{p.label}</option>
							{/each}
						</select>
						<button onclick={() => addToChain(taskType)}>Ekle</button>
					</div>
				{/if}
			</div>
		{/each}
	</section>
</div>

<style>
	.providers-page {
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

	h2 {
		font-size: 1rem;
		margin: 0 0 0.75rem;
	}

	section {
		margin-bottom: 2rem;
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

	.chip.connected {
		color: #2e7d32;
		border-color: #2e7d32;
	}

	.description {
		font-size: 0.8rem;
		color: var(--muted);
		margin: 0.3rem 0 0;
	}

	.key-editor {
		display: flex;
		gap: 0.4rem;
		margin-top: 0.6rem;
	}

	.test-result {
		font-size: 0.8rem;
		margin: 0.4rem 0 0;
	}

	.controls {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-wrap: wrap;
	}

	.toggle {
		display: flex;
		align-items: center;
		gap: 0.3rem;
		font-size: 0.8rem;
		cursor: pointer;
	}

	.controls button,
	.key-editor button {
		padding: 0.35rem 0.7rem;
		border-radius: 6px;
		border: 1px solid var(--border);
		background: transparent;
		color: var(--fg);
		cursor: pointer;
		font-size: 0.8rem;
	}

	.controls button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.controls button.danger {
		color: var(--error);
		border-color: var(--error);
	}

	button.primary {
		background: var(--accent);
		color: var(--accent-fg);
		border-color: var(--accent);
		font-weight: 600;
	}

	.chain-row {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		flex-wrap: wrap;
		padding: 0.6rem 0;
		border-bottom: 1px solid var(--border);
	}

	.task-label {
		font-size: 0.85rem;
		font-weight: 600;
		min-width: 140px;
	}

	.chain-items {
		display: flex;
		gap: 0.4rem;
		flex-wrap: wrap;
		flex: 1;
	}

	.chain-chip {
		display: inline-flex;
		align-items: center;
		gap: 0.2rem;
		font-size: 0.8rem;
		border: 1px solid var(--border);
		border-radius: 999px;
		padding: 0.15rem 0.3rem 0.15rem 0.6rem;
	}

	.icon-btn {
		border: none;
		background: transparent;
		color: var(--muted);
		cursor: pointer;
		font-size: 0.8rem;
		padding: 0 0.15rem;
		line-height: 1;
	}

	.icon-btn:disabled {
		opacity: 0.3;
		cursor: not-allowed;
	}

	.chain-add {
		display: flex;
		gap: 0.4rem;
	}

	select,
	input[type='password'] {
		background: var(--bg);
		color: var(--fg);
		border: 1px solid var(--border);
		border-radius: 6px;
		padding: 0.35rem 0.5rem;
		font-family: var(--font-sans);
		font-size: 0.85rem;
	}
</style>
