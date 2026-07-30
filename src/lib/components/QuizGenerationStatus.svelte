<script lang="ts">
	import { goto } from '$app/navigation';
	import { quizGeneration, dismissQuizGeneration } from '$lib/quiz-generation.svelte';

	const STAGE_LABELS: Record<string, string> = {
		retrieving: 'Kaynaklar aranıyor...',
		generating: 'Sorular üretiliyor...',
		validating: 'Doğrulanıyor...',
		retrying: 'Doğrulama başarısız, tekrar deneniyor...'
	};

	function viewQuiz() {
		if (quizGeneration.status.phase !== 'done') return;
		const quizId = quizGeneration.status.quizId;
		dismissQuizGeneration();
		goto(`/study/quiz/${quizId}`);
	}
</script>

{#if quizGeneration.status.phase === 'generating'}
	<div class="toast generating">
		<span class="spinner" aria-hidden="true"></span>
		<span>{STAGE_LABELS[quizGeneration.status.stage] ?? 'İşleniyor...'}</span>
	</div>
{:else if quizGeneration.status.phase === 'done'}
	<button class="toast done" onclick={viewQuiz}>✓ Test hazır — görüntülemek için tıkla</button>
{:else if quizGeneration.status.phase === 'error'}
	<div class="toast error">
		<span>Test oluşturulamadı: {quizGeneration.status.message}</span>
		<button class="dismiss" onclick={dismissQuizGeneration} title="Kapat">✕</button>
	</div>
{/if}

<style>
	.toast {
		position: fixed;
		right: 1.25rem;
		bottom: 1.25rem;
		display: flex;
		align-items: center;
		gap: 0.6rem;
		background: var(--background);
		color: var(--foreground);
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
		border-color: var(--primary);
		color: var(--primary);
		font-weight: 600;
	}

	.toast.error {
		border-color: var(--destructive);
		color: var(--destructive);
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
		border-top-color: var(--primary);
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
