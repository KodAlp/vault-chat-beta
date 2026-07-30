<script lang="ts">
	import { onMount } from 'svelte';
	import type { VaultRecord } from '$lib/types';

	let vaults = $state<VaultRecord[]>([]);
	let activeVaultId = $state<string | null>(null);
	let loadError = $state('');
	let newVaultName = $state('');
	let createError = $state('');
	let renamingId = $state<string | null>(null);
	let renameValue = $state('');
	let deleteTarget = $state<{ vault: VaultRecord; chatCount: number } | null>(null);
	let deleteError = $state('');

	async function loadVaults() {
		try {
			const res = await fetch('/api/vaults');
			if (!res.ok) throw new Error();
			const data = (await res.json()) as { vaults: VaultRecord[]; activeVaultId: string | null };
			vaults = data.vaults;
			activeVaultId = data.activeVaultId;
		} catch {
			loadError = 'Vault listesi alınamadı.';
		}
	}

	onMount(loadVaults);

	async function createVault() {
		createError = '';
		const name = newVaultName.trim();
		if (!name) return;
		try {
			const res = await fetch('/api/vaults', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ name })
			});
			if (!res.ok) throw new Error((await res.json().catch(() => null))?.message ?? 'Oluşturulamadı');
			newVaultName = '';
			await loadVaults();
		} catch (err) {
			createError = err instanceof Error ? err.message : 'Vault oluşturulamadı.';
		}
	}

	async function activate(id: string) {
		try {
			await fetch(`/api/vaults/${id}/activate`, { method: 'POST' });
			await loadVaults();
		} catch {
			loadError = 'Aktif vault değiştirilemedi.';
		}
	}

	function startRename(vault: VaultRecord) {
		renamingId = vault.id;
		renameValue = vault.name;
	}

	async function submitRename(id: string) {
		const name = renameValue.trim();
		if (!name) return;
		try {
			await fetch(`/api/vaults/${id}`, {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ name })
			});
			renamingId = null;
			await loadVaults();
		} catch {
			loadError = 'Yeniden adlandırılamadı.';
		}
	}

	async function requestDelete(vault: VaultRecord) {
		deleteError = '';
		try {
			const res = await fetch(`/api/vaults/${vault.id}`);
			if (!res.ok) throw new Error();
			const info = (await res.json()) as { vault: VaultRecord; chatCount: number };
			deleteTarget = info;
		} catch {
			deleteError = 'Vault bilgisi alınamadı.';
		}
	}

	async function confirmDelete() {
		if (!deleteTarget) return;
		try {
			const res = await fetch(`/api/vaults/${deleteTarget.vault.id}?confirm=true`, {
				method: 'DELETE'
			});
			if (!res.ok) throw new Error((await res.json().catch(() => null))?.message ?? 'Silinemedi');
			deleteTarget = null;
			await loadVaults();
		} catch (err) {
			deleteError = err instanceof Error ? err.message : 'Vault silinemedi.';
		}
	}
</script>

<svelte:head>
	<title>Vault'lar — Vault Chat</title>
</svelte:head>

<div class="vaults-settings">
	<header>
		<a href="/settings">← Ayarlar</a>
		<h1>Vault'lar</h1>
	</header>

	<p class="hint">
		Her vault kendi kaynak kütüphanesini ve arama indeksini tutar — birbirlerine karışmazlar.
		Sohbet geçmişi vault başına ayrılır, sohbet ekranı her zaman aktif vault üzerinde çalışır.
	</p>

	{#if loadError}
		<p class="warn">{loadError}</p>
	{/if}

	<section>
		<h2>Mevcut vault'lar</h2>
		<ul class="vault-list">
			{#each vaults as vault (vault.id)}
				<li class="vault-row" class:active={vault.id === activeVaultId}>
					{#if renamingId === vault.id}
						<input
							type="text"
							bind:value={renameValue}
							onkeydown={(e) => e.key === 'Enter' && submitRename(vault.id)}
						/>
						<button type="button" onclick={() => submitRename(vault.id)}>Kaydet</button>
						<button type="button" onclick={() => (renamingId = null)}>Vazgeç</button>
					{:else}
						<span class="name">
							{vault.name}
							{#if vault.id === activeVaultId}<span class="badge">aktif</span>{/if}
						</span>
						<div class="actions">
							{#if vault.id !== activeVaultId}
								<button type="button" onclick={() => activate(vault.id)}>Aktif yap</button>
							{/if}
							<button type="button" onclick={() => startRename(vault)}>Yeniden adlandır</button>
							<button type="button" class="danger" onclick={() => requestDelete(vault)}>Sil</button>
						</div>
					{/if}
				</li>
			{/each}
		</ul>
	</section>

	<section>
		<h2>Yeni vault</h2>
		<div class="new-vault-row">
			<input
				type="text"
				placeholder="Vault adı"
				bind:value={newVaultName}
				onkeydown={(e) => e.key === 'Enter' && createVault()}
			/>
			<button type="button" onclick={createVault}>Oluştur</button>
		</div>
		{#if createError}
			<p class="warn">{createError}</p>
		{/if}
	</section>
</div>

{#if deleteTarget}
	<div class="modal-backdrop">
		<button
			type="button"
			class="modal-backdrop-close"
			aria-label="Kapat"
			onclick={() => (deleteTarget = null)}
		></button>
		<div class="modal" role="dialog" aria-modal="true">
			<h2>"{deleteTarget.vault.name}" silinsin mi?</h2>
			<p>
				Kütüphanesi, arama indeksi ve
				{#if deleteTarget.chatCount > 0}
					<strong>{deleteTarget.chatCount} sohbet</strong>
				{:else}
					sohbet geçmişi (yok)
				{/if}
				kalıcı olarak silinecek. Bu işlem geri alınamaz.
			</p>
			{#if deleteError}
				<p class="warn">{deleteError}</p>
			{/if}
			<div class="modal-actions">
				<button type="button" onclick={() => (deleteTarget = null)}>Vazgeç</button>
				<button type="button" class="danger" onclick={confirmDelete}>Sil</button>
			</div>
		</div>
	</div>
{/if}

<style>
	.vaults-settings {
		max-width: 640px;
		margin: 0 auto;
		padding: 1.5rem 1rem 3rem;
	}

	header {
		display: flex;
		align-items: baseline;
		gap: 1rem;
		margin-bottom: 1rem;
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
		margin-bottom: 1.5rem;
	}

	.vault-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.vault-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		padding: 0.5rem 0.75rem;
		border: 1px solid var(--border);
		border-radius: 6px;
		font-size: 0.9rem;
	}

	.vault-row.active {
		border-color: var(--primary);
	}

	.name {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.badge {
		font-size: 0.7rem;
		color: var(--primary);
		border: 1px solid var(--primary);
		border-radius: 999px;
		padding: 0.1rem 0.5rem;
	}

	.actions {
		display: flex;
		gap: 0.4rem;
	}

	button {
		padding: 0.35rem 0.7rem;
		border-radius: 6px;
		border: 1px solid var(--border);
		background: transparent;
		color: var(--foreground);
		cursor: pointer;
		font-size: 0.8rem;
	}

	button.danger {
		border-color: var(--destructive);
		color: var(--destructive);
	}

	.new-vault-row {
		display: flex;
		gap: 0.5rem;
	}

	input[type='text'] {
		background: var(--background);
		color: var(--foreground);
		border: 1px solid var(--border);
		border-radius: 6px;
		padding: 0.4rem 0.5rem;
		font-size: 0.9rem;
		flex: 1;
		max-width: 320px;
	}

	.warn {
		color: var(--destructive);
		font-size: 0.85rem;
	}

	.modal-backdrop {
		position: fixed;
		inset: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 100;
	}

	.modal-backdrop-close {
		position: absolute;
		inset: 0;
		border: none;
		padding: 0;
		background: rgba(0, 0, 0, 0.5);
		cursor: default;
	}

	.modal {
		position: relative;
		background: var(--background);
		border: 1px solid var(--border);
		border-radius: 8px;
		padding: 1.5rem;
		max-width: 420px;
		width: 90%;
	}

	.modal h2 {
		margin-top: 0;
	}

	.modal-actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
		margin-top: 1.5rem;
	}
</style>
