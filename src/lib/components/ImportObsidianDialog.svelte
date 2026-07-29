<script lang="ts">
	import type { ObsidianImportEvent, ImportResultItem } from '$lib/types';

	let open = $state(false);
	let sourcePath = $state('');
	type Phase = 'idle' | 'running' | 'done' | 'error';
	let phase = $state<Phase>('idle');
	let items = $state<ImportResultItem[]>([]);
	let errorMessage = $state('');
	let statusLabel = $state('');

	function openDialog() {
		open = true;
		phase = 'idle';
		items = [];
		errorMessage = '';
	}

	function close() {
		open = false;
	}

	async function run() {
		if (!sourcePath.trim()) return;
		phase = 'running';
		statusLabel = 'Taranıyor...';
		items = [];

		try {
			const res = await fetch('/api/library/import-obsidian', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ sourcePath: sourcePath.trim() })
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
					const event = JSON.parse(line.slice(5)) as ObsidianImportEvent;
					if (event.type === 'progress') {
						statusLabel = event.fileName ? `İşleniyor: ${event.fileName}` : 'Taranıyor...';
					} else if (event.type === 'item') {
						items = [...items, event.item];
					} else if (event.type === 'done') {
						items = event.summary.items;
						phase = 'done';
					} else if (event.type === 'error') {
						errorMessage = event.message;
						phase = 'error';
					}
				}
			}
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : 'İçe aktarma başarısız';
			phase = 'error';
		}
	}

	const STATUS_LABELS: Record<string, string> = {
		converted: 'kopyalandı',
		skipped: 'atlandı',
		needs_review: 'gözden geçirilmeli',
		failed: 'başarısız'
	};

	let counts = $derived(
		items.reduce(
			(acc, i) => {
				acc[i.status] = (acc[i.status] ?? 0) + 1;
				return acc;
			},
			{} as Record<string, number>
		)
	);
</script>

<button class="trigger" onclick={openDialog}>İçe Aktar</button>

{#if open}
	<div class="overlay" onclick={close} onkeydown={(e) => e.key === 'Escape' && close()} role="presentation">
		<div class="dialog" onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.stopPropagation()} role="dialog" aria-modal="true" tabindex="-1">
			<h2>Obsidian Vault'unu İçe Aktar</h2>
			<p class="hint">Tek yönlü kopya — kaynak vault'una asla yazılmaz. Değişmemiş notlar yeniden içe aktarmada atlanır.</p>

			{#if phase === 'idle'}
				<label class="field">
					Kaynak vault yolu
					<input type="text" bind:value={sourcePath} placeholder="örn. C:\Kullanıcılar\...\MyVault" />
				</label>
				<div class="actions">
					<button onclick={close}>İptal</button>
					<button class="primary" onclick={run} disabled={!sourcePath.trim()}>Başlat</button>
				</div>
			{:else if phase === 'running'}
				<p class="status"><span class="spinner" aria-hidden="true"></span> {statusLabel}</p>
				<p class="hint">{items.length} dosya işlendi...</p>
			{:else if phase === 'done'}
				<p class="summary">
					{#each Object.entries(counts) as [status, n] (status)}
						<span class="count">{STATUS_LABELS[status] ?? status}: {n}</span>
					{/each}
				</p>
				<div class="result-list">
					{#each items.filter((i) => i.status !== 'skipped') as item (item.fileName)}
						<div class="result-row">
							<span class="status-badge {item.status}">{STATUS_LABELS[item.status] ?? item.status}</span>
							<span class="file-name">{item.fileName}</span>
							{#if item.reason}<span class="reason">{item.reason}</span>{/if}
						</div>
					{/each}
				</div>
				<div class="actions">
					<button class="primary" onclick={close}>Kapat</button>
				</div>
			{:else if phase === 'error'}
				<p class="warn">{errorMessage}</p>
				<div class="actions">
					<button onclick={close}>Kapat</button>
				</div>
			{/if}
		</div>
	</div>
{/if}

<style>
	.trigger {
		padding: 0.5rem 1rem;
		border-radius: 8px;
		border: 1px solid var(--accent);
		background: transparent;
		color: var(--accent);
		font-weight: 600;
		cursor: pointer;
		font-size: 0.9rem;
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

	.dialog h2 {
		margin: 0 0 0.5rem;
		font-size: 1.1rem;
	}

	.hint {
		font-size: 0.8rem;
		color: var(--muted);
		margin-bottom: 1rem;
	}

	.field {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		font-size: 0.85rem;
		margin-bottom: 0.9rem;
	}

	input[type='text'] {
		background: var(--bg);
		color: var(--fg);
		border: 1px solid var(--border);
		border-radius: 6px;
		padding: 0.4rem 0.5rem;
		font-family: var(--font-sans);
		font-size: 0.9rem;
	}

	.status {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.9rem;
	}

	.spinner {
		display: inline-block;
		width: 0.9rem;
		height: 0.9rem;
		border: 2px solid var(--border);
		border-top-color: var(--accent);
		border-radius: 50%;
		animation: spin 0.7s linear infinite;
	}

	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}

	.summary {
		display: flex;
		gap: 0.6rem;
		flex-wrap: wrap;
		margin-bottom: 1rem;
	}

	.count {
		font-size: 0.8rem;
		border: 1px solid var(--border);
		border-radius: 999px;
		padding: 0.2rem 0.6rem;
	}

	.result-list {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		max-height: 40vh;
		overflow-y: auto;
	}

	.result-row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.8rem;
		padding: 0.25rem 0;
		border-bottom: 1px solid var(--border);
	}

	.status-badge {
		font-size: 0.68rem;
		border-radius: 999px;
		padding: 0.1rem 0.5rem;
		flex-shrink: 0;
	}

	.status-badge.converted {
		background: color-mix(in srgb, var(--accent) 15%, transparent);
		color: var(--accent);
	}

	.status-badge.needs_review {
		background: color-mix(in srgb, orange 20%, transparent);
		color: #b8860b;
	}

	.status-badge.failed {
		background: color-mix(in srgb, var(--error) 15%, transparent);
		color: var(--error);
	}

	.file-name {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.reason {
		color: var(--muted);
		font-size: 0.72rem;
	}

	.warn {
		color: var(--error);
		font-size: 0.85rem;
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

	.actions button.primary {
		background: var(--accent);
		color: var(--accent-fg);
		border-color: var(--accent);
		font-weight: 600;
	}

	.actions button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
</style>
