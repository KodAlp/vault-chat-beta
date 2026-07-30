<script lang="ts">
	import { onMount } from 'svelte';
	import { renderMarkdown } from '$lib/markdown';
	import { settings } from '$lib/settings.svelte';
	import { obsidianUri, libraryViewerUrl } from '$lib/sourceLink';
	import type { PageProps } from './$types';
	import type {
		QuizItemView,
		QuizView,
		SubmitAttemptResponse,
		AttemptResultItem
	} from '$lib/types';

	let { data }: PageProps = $props();

	type Phase = 'loading' | 'taking' | 'submitting' | 'results' | 'error';

	let phase = $state<Phase>('loading');
	let quiz = $state<QuizView | null>(null);
	let items = $state<QuizItemView[]>([]);
	let attemptId = $state('');
	let currentIndex = $state(0);
	let answers = $state<Record<string, string>>({});
	let errorMessage = $state('');
	let result = $state<SubmitAttemptResponse | null>(null);
	let renderedResults = $state<
		{ item: AttemptResultItem; questionHtml: string; explanationHtml: string }[]
	>([]);

	let questionHtml = $state('');
	let optionsHtml = $state<string[]>([]);

	onMount(async () => {
		try {
			const [quizRes, attemptRes] = await Promise.all([
				fetch(`/api/study/quizzes/${data.quizId}`),
				fetch('/api/study/attempts', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ quizId: data.quizId })
				})
			]);
			if (!quizRes.ok || !attemptRes.ok) throw new Error();
			const quizData = (await quizRes.json()) as { quiz: QuizView; items: QuizItemView[] };
			const attemptData = (await attemptRes.json()) as { attemptId: string };
			quiz = quizData.quiz;
			items = quizData.items;
			attemptId = attemptData.attemptId;
			if (items.length === 0) {
				errorMessage = 'Bu sınavda soru yok.';
				phase = 'error';
			} else {
				phase = 'taking';
			}
		} catch {
			errorMessage = 'Sınav yüklenemedi.';
			phase = 'error';
		}
	});

	$effect(() => {
		const item = items[currentIndex];
		if (!item) return;
		renderMarkdown(item.question).then((html) => (questionHtml = html));
		if (item.options) {
			Promise.all(item.options.map((o) => renderMarkdown(o))).then((htmls) => (optionsHtml = htmls));
		} else {
			optionsHtml = [];
		}
		if (answers[item.id] === undefined) answers[item.id] = '';
	});

	function selectAnswer(value: string) {
		const item = items[currentIndex];
		if (item) answers[item.id] = value;
	}

	function next() {
		if (currentIndex < items.length - 1) currentIndex++;
	}

	function prev() {
		if (currentIndex > 0) currentIndex--;
	}

	async function finish() {
		phase = 'submitting';
		try {
			const res = await fetch(`/api/study/attempts/${attemptId}`, {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					answers: items.map((i) => ({ itemId: i.id, given: answers[i.id] ?? '' })),
					fastModel: settings.fastModel
				})
			});
			if (!res.ok) throw new Error();
			result = (await res.json()) as SubmitAttemptResponse;
			renderedResults = await Promise.all(
				result.items.map(async (item) => ({
					item,
					questionHtml: await renderMarkdown(item.question),
					explanationHtml: await renderMarkdown(item.explanation)
				}))
			);
			phase = 'results';
		} catch {
			errorMessage = 'Sınav gönderilemedi.';
			phase = 'error';
		}
	}
</script>

<svelte:head>
	<title>{quiz?.title ?? 'Test'} — Vault Chat</title>
</svelte:head>

<div class="quiz-screen">
	<a class="home-link" href="/">← Ana sayfa</a>

	{#if phase === 'loading'}
		<p class="status">Yükleniyor...</p>
	{:else if phase === 'error'}
		<p class="status error">{errorMessage}</p>
	{:else if phase === 'taking' || phase === 'submitting'}
		{@const item = items[currentIndex]}
		<div class="progress-bar">
			<div class="progress-fill" style="width: {((currentIndex + 1) / items.length) * 100}%"></div>
		</div>
		<p class="progress-label">{currentIndex + 1} / {items.length}</p>

		<div class="question-card">
			<div class="question markdown-body">{@html questionHtml}</div>

			{#if item.type === 'multiple_choice' && item.options}
				<div class="options">
					{#each item.options as option, i (option)}
						<button
							class="option"
							class:selected={answers[item.id] === option}
							onclick={() => selectAnswer(option)}
						>
							<span class="option-letter">{String.fromCharCode(65 + i)})</span>
							{@html optionsHtml[i] ?? option}
						</button>
					{/each}
				</div>
			{:else if item.type === 'true_false'}
				<div class="options">
					<button class="option" class:selected={answers[item.id] === 'true'} onclick={() => selectAnswer('true')}>
						Doğru
					</button>
					<button class="option" class:selected={answers[item.id] === 'false'} onclick={() => selectAnswer('false')}>
						Yanlış
					</button>
				</div>
			{:else}
				<textarea
					class="open-answer"
					bind:value={answers[item.id]}
					placeholder="Cevabını yaz..."
				></textarea>
			{/if}
		</div>

		<div class="nav">
			<button onclick={prev} disabled={currentIndex === 0 || phase === 'submitting'}>Geri</button>
			{#if currentIndex < items.length - 1}
				<button onclick={next} disabled={phase === 'submitting'}>İleri</button>
			{:else}
				<button class="primary" onclick={finish} disabled={phase === 'submitting'}>
					{phase === 'submitting' ? 'Gönderiliyor...' : 'Bitir'}
				</button>
			{/if}
		</div>
	{:else if phase === 'results' && result}
		<h1>Sonuç: {Math.round(result.score * 100)}%</h1>
		<div class="results">
			{#each renderedResults as r (r.item.itemId)}
				<div class="result-item" class:correct={r.item.isCorrect} class:incorrect={!r.item.isCorrect}>
					<div class="result-mark">{r.item.isCorrect ? '✓' : '✗'}</div>
					<div class="result-body">
						<div class="question markdown-body">{@html r.questionHtml}</div>
						<p class="given">Cevabın: {r.item.given || '(boş)'}</p>
						{#if !r.item.isCorrect}
							<p class="correct-answer">Doğru cevap: {r.item.correctAnswer}</p>
						{/if}
						<div class="explanation markdown-body">{@html r.explanationHtml}</div>
						{#if r.item.modelFeedback}
							<p class="model-feedback"><strong>Model değerlendirmesi:</strong> {r.item.modelFeedback}</p>
						{/if}
						<a class="source-link" href={obsidianUri(r.item.sourcePath)} title={r.item.headingPath}>
							{r.item.sourcePath}
						</a>
						<a class="source-link" href={libraryViewerUrl(r.item.sourcePath)} title="Kütüphanede görüntüle">
							⇱
						</a>
					</div>
				</div>
			{/each}
		</div>
	{/if}
</div>

<style>
	.quiz-screen {
		max-width: 640px;
		margin: 0 auto;
		padding: 1.5rem 1rem 3rem;
	}

	.home-link {
		display: inline-block;
		font-size: 0.9rem;
		text-decoration: none;
		margin-bottom: 1.5rem;
	}

	.status {
		color: var(--muted-foreground);
		text-align: center;
		margin-top: 3rem;
	}

	.status.error {
		color: var(--destructive);
	}

	.progress-bar {
		height: 6px;
		background: var(--border);
		border-radius: 999px;
		overflow: hidden;
	}

	.progress-fill {
		height: 100%;
		background: var(--primary);
		transition: width 0.2s ease;
	}

	.progress-label {
		font-size: 0.75rem;
		color: var(--muted-foreground);
		margin: 0.4rem 0 1.5rem;
	}

	.question-card {
		background: var(--bubble-assistant);
		border-radius: 10px;
		padding: 1.25rem;
		margin-bottom: 1.5rem;
	}

	.question {
		line-height: 1.6;
		margin-bottom: 1rem;
	}

	.options {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.option {
		display: flex;
		align-items: baseline;
		gap: 0.5rem;
		text-align: left;
		padding: 0.6rem 0.9rem;
		border-radius: 8px;
		border: 1px solid var(--border);
		background: var(--background);
		color: var(--foreground);
		cursor: pointer;
		font-size: 0.95rem;
	}

	.option-letter {
		flex-shrink: 0;
		font-weight: 600;
		color: var(--muted-foreground);
	}

	.option.selected .option-letter {
		color: var(--primary);
	}

	.option.selected {
		border-color: var(--primary);
		background: var(--bubble-user);
	}

	.open-answer {
		width: 100%;
		min-height: 6rem;
		resize: vertical;
		padding: 0.6rem 0.75rem;
		border-radius: 8px;
		border: 1px solid var(--border);
		background: var(--background);
		color: var(--foreground);
		font-family: var(--font-sans);
		font-size: 0.95rem;
	}

	.nav {
		display: flex;
		justify-content: space-between;
	}

	.nav button {
		padding: 0.5rem 1.2rem;
		border-radius: 8px;
		border: 1px solid var(--border);
		background: transparent;
		color: var(--foreground);
		cursor: pointer;
	}

	.nav button.primary {
		background: var(--primary);
		color: var(--primary-foreground);
		border-color: var(--primary);
		font-weight: 600;
	}

	.nav button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.results {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	.result-item {
		display: flex;
		gap: 0.75rem;
		padding: 1rem;
		border-radius: 10px;
		border: 1px solid var(--border);
	}

	.result-item.correct {
		border-left: 3px solid var(--primary);
	}

	.result-item.incorrect {
		border-left: 3px solid var(--destructive);
	}

	.result-mark {
		font-size: 1.1rem;
		font-weight: 700;
	}

	.result-item.correct .result-mark {
		color: var(--primary);
	}

	.result-item.incorrect .result-mark {
		color: var(--destructive);
	}

	.result-body {
		flex: 1;
		min-width: 0;
	}

	.given,
	.correct-answer {
		font-size: 0.9rem;
		margin: 0.3rem 0;
	}

	.correct-answer {
		color: var(--destructive);
	}

	.explanation {
		font-size: 0.9rem;
		color: var(--muted-foreground);
		margin-top: 0.5rem;
	}

	.model-feedback {
		font-size: 0.85rem;
		margin-top: 0.5rem;
	}

	.source-link {
		display: inline-block;
		margin-top: 0.6rem;
		font-size: 0.75rem;
		color: var(--muted-foreground);
		text-decoration: none;
		border: 1px solid var(--border);
		border-radius: 999px;
		padding: 0.2rem 0.65rem;
	}

	.source-link:hover {
		color: var(--primary);
		border-color: var(--primary);
	}
</style>
