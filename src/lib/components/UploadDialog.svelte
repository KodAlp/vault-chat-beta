<script lang="ts">
	import type { ImportEvent } from '$lib/types';

	let { onImported }: { onImported: () => void } = $props();

	let open = $state(false);
	type Phase = 'idle' | 'uploading' | 'confirming' | 'saving' | 'error';
	let phase = $state<Phase>('idle');
	let statusLabel = $state('');
	let errorMessage = $state('');

	let selectedFile = $state<File | null>(null);
	let importId = $state('');
	let title = $state('');
	let domain = $state('');
	let level = $state('undergraduate');
	let warnings = $state<string[]>([]);

	const STAGE_LABELS: Record<string, string> = {
		queued: 'Sırada...',
		converting: 'Dönüştürülüyor...',
		postprocessing: 'İşleniyor...'
	};

	function openDialog() {
		open = true;
		phase = 'idle';
		selectedFile = null;
		errorMessage = '';
	}

	function closeDialog() {
		open = false;
	}

	function onFileChange(e: Event) {
		const input = e.currentTarget as HTMLInputElement;
		selectedFile = input.files?.[0] ?? null;
	}

	async function upload() {
		if (!selectedFile) return;
		phase = 'uploading';
		statusLabel = 'Yükleniyor...';

		const formData = new FormData();
		formData.append('file', selectedFile);

		try {
			const res = await fetch('/api/import', { method: 'POST', body: formData });
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
					const event = JSON.parse(line.slice(5)) as ImportEvent;
					if (event.type === 'progress') {
						statusLabel = STAGE_LABELS[event.stage] ?? event.stage;
					} else if (event.type === 'ready') {
						importId = event.importId;
						title = event.proposed.title;
						domain = event.proposed.domain;
						level = event.proposed.level;
						warnings = event.warnings;
						phase = 'confirming';
					} else if (event.type === 'error') {
						errorMessage = event.message;
						phase = 'error';
					}
				}
			}
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : 'Yükleme başarısız';
			phase = 'error';
		}
	}

	async function confirm() {
		if (!title.trim() || !domain.trim()) return;
		phase = 'saving';
		try {
			const res = await fetch(`/api/library/import/${importId}/confirm`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ title: title.trim(), domain: domain.trim(), level })
			});
			if (!res.ok) throw new Error('Kaydedilemedi');
			open = false;
			onImported();
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : 'Kaydedilemedi';
			phase = 'error';
		}
	}

	async function cancelStaged() {
		if (importId) {
			await fetch(`/api/library/import/${importId}/cancel`, { method: 'POST' }).catch(() => {});
		}
		closeDialog();
	}
</script>

<button class="trigger" onclick={openDialog} title="Belge yükle">+ Yükle</button>

{#if open}
	<div class="overlay" onclick={() => phase !== 'saving' && cancelStaged()} onkeydown={(e) => e.key === 'Escape' && cancelStaged()} role="presentation">
		<div class="dialog" onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.stopPropagation()} role="dialog" aria-modal="true" tabindex="-1">
			<h2>Belge Yükle</h2>

			{#if phase === 'idle'}
				<label class="field">
					Dosya (DOCX / PPTX / XLSX / HTML / EPUB / basit PDF)
					<input type="file" onchange={onFileChange} accept=".docx,.pptx,.xlsx,.html,.htm,.epub,.pdf" />
				</label>
				<div class="actions">
					<button onclick={cancelStaged}>İptal</button>
					<button class="primary" onclick={upload} disabled={!selectedFile}>Yükle</button>
				</div>
			{:else if phase === 'uploading'}
				<p class="status"><span class="spinner" aria-hidden="true"></span> {statusLabel}</p>
			{:else if phase === 'confirming' || phase === 'saving'}
				{#if warnings.length > 0}
					<p class="warn">{warnings.join(' ')}</p>
				{/if}
				<label class="field">
					Başlık
					<input type="text" bind:value={title} />
				</label>
				<label class="field">
					Domain
					<input type="text" bind:value={domain} placeholder="örn. math" />
				</label>
				<label class="field">
					Seviye
					<select bind:value={level}>
						<option value="undergraduate">undergraduate</option>
						<option value="graduate">graduate</option>
						<option value="phd">phd</option>
					</select>
				</label>
				<div class="actions">
					<button onclick={cancelStaged} disabled={phase === 'saving'}>İptal</button>
					<button class="primary" onclick={confirm} disabled={phase === 'saving' || !title.trim() || !domain.trim()}>
						{phase === 'saving' ? 'Kaydediliyor...' : 'Kaydet'}
					</button>
				</div>
			{:else if phase === 'error'}
				<p class="warn">{errorMessage}</p>
				<div class="actions">
					<button onclick={cancelStaged}>Kapat</button>
				</div>
			{/if}
		</div>
	</div>
{/if}

<style>
	.trigger {
		width: 100%;
		padding: 0.4rem 0.6rem;
		border-radius: 6px;
		border: 1px solid var(--border);
		background: transparent;
		color: var(--muted-foreground);
		cursor: pointer;
		font-size: 0.8rem;
		margin-bottom: 0.6rem;
	}

	.trigger:hover {
		color: var(--primary);
		border-color: var(--primary);
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
		background: var(--background);
		color: var(--foreground);
		border: 1px solid var(--border);
		border-radius: 12px;
		padding: 1.25rem;
		width: min(440px, 90vw);
		max-height: 85vh;
		overflow-y: auto;
		box-shadow: 0 8px 24px rgb(0 0 0 / 0.25);
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

	input[type='text'],
	input[type='file'],
	select {
		background: var(--background);
		color: var(--foreground);
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
		color: var(--muted-foreground);
	}

	.warn {
		color: var(--destructive);
		font-size: 0.85rem;
	}

	.spinner {
		display: inline-block;
		width: 0.9rem;
		height: 0.9rem;
		border: 2px solid var(--border);
		border-top-color: var(--primary);
		border-radius: 50%;
		animation: spin 0.7s linear infinite;
	}

	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
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
		color: var(--foreground);
		cursor: pointer;
		font-size: 0.9rem;
	}

	.actions button.primary {
		background: var(--primary);
		color: var(--primary-foreground);
		border-color: var(--primary);
		font-weight: 600;
	}

	.actions button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
</style>
