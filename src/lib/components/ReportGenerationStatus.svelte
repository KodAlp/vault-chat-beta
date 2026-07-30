<script lang="ts">
	import { goto } from '$app/navigation';
	import { reportGeneration, dismissReportGeneration } from '$lib/report-generation.svelte';

	const STAGE_LABELS: Record<string, string> = {
		retrieving: 'Kaynaklar aranıyor...',
		generating: 'Rapor yazılıyor...',
		validating: 'Doğrulanıyor...',
		retrying: 'Doğrulama başarısız, tekrar deneniyor...'
	};

	function viewReport() {
		if (reportGeneration.status.phase !== 'done') return;
		const reportId = reportGeneration.status.reportId;
		dismissReportGeneration();
		goto(`/study/report/${reportId}`);
	}
</script>

{#if reportGeneration.status.phase === 'generating'}
	<div class="toast generating">
		<span class="spinner" aria-hidden="true"></span>
		<span>{STAGE_LABELS[reportGeneration.status.stage] ?? 'İşleniyor...'}</span>
	</div>
{:else if reportGeneration.status.phase === 'done'}
	<button class="toast done" onclick={viewReport}>✓ Rapor hazır — görüntülemek için tıkla</button>
{:else if reportGeneration.status.phase === 'error'}
	<div class="toast error">
		<span>Rapor oluşturulamadı: {reportGeneration.status.message}</span>
		<button class="dismiss" onclick={dismissReportGeneration} title="Kapat">✕</button>
	</div>
{/if}

<style>
	.toast {
		position: fixed;
		right: 1.25rem;
		bottom: 7.25rem;
		display: flex;
		align-items: center;
		gap: 0.6rem;
		background: var(--bg);
		color: var(--fg);
		border: 1px solid var(--border);
		border-radius: 999px;
		padding: 0.6rem 1rem;
		font-size: 0.85rem;
		box-shadow: 0 4px 16px rgb(0 0 0 / 0.2);
		z-index: 200;
	}

	button.toast {
		cursor: pointer;
		font-family: var(--font-sans);
	}

	.toast.done {
		border-color: var(--accent);
		color: var(--accent);
		font-weight: 600;
	}

	.toast.error {
		border-color: var(--error);
		color: var(--error);
		max-width: min(360px, 80vw);
	}

	.dismiss {
		background: transparent;
		border: none;
		color: inherit;
		cursor: pointer;
		font-size: 0.85rem;
		padding: 0;
		flex-shrink: 0;
	}

	.spinner {
		display: inline-block;
		width: 0.9rem;
		height: 0.9rem;
		border: 2px solid var(--border);
		border-top-color: var(--accent);
		border-radius: 50%;
		animation: spin 0.7s linear infinite;
		flex-shrink: 0;
	}

	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}
</style>
