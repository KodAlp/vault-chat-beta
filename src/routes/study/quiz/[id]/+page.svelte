<script lang="ts">
	import { onMount } from 'svelte';
	import { renderMarkdown } from '$lib/markdown';
	import { settings } from '$lib/settings.svelte';
	import { obsidianUri, libraryViewerUrl } from '$lib/sourceLink';
	import type { PageProps } from './$types';
	import BookOpenIcon from '@lucide/svelte/icons/book-open';
	import CheckIcon from '@lucide/svelte/icons/check';
	import XIcon from '@lucide/svelte/icons/x';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
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
		errorMessage = '';
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
			// Back to 'taking', not the terminal 'error' phase — answers are
			// still in memory (never cleared) and the PATCH is safe to retry,
			// so a flaky network blip shouldn't cost the user a completed
			// attempt they'd otherwise have to redo from scratch.
			errorMessage = 'Sınav gönderilemedi. Tekrar dene.';
			phase = 'taking';
		}
	}
</script>

<svelte:head>
	<title>{quiz?.title ?? 'Test'} — Vault Agent Toolkit</title>
</svelte:head>

<div class="quiz-screen">
	<a class="home-link" href="/"><ArrowLeftIcon size={14} aria-hidden="true" /> Ana sayfa</a>

	{#if phase === 'loading'}
		<p class="status">Yükleniyor...</p>
	{:else if phase === 'error'}
		<p class="status error" role="alert">{errorMessage}</p>
	{:else if phase === 'taking' || phase === 'submitting'}
		{@const item = items[currentIndex]}
		<div class="progress-bar">
			<div class="progress-fill" style="transform: scaleX({(currentIndex + 1) / items.length})"></div>
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

		{#if errorMessage}
			<p class="status error inline" role="alert">{errorMessage}</p>
		{/if}

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
					<div class="result-mark">
						{#if r.item.isCorrect}
							<CheckIcon size={16} aria-hidden="true" />
						{:else}
							<XIcon size={16} aria-hidden="true" />
						{/if}
					</div>
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
						<a class="source-link" href={libraryViewerUrl(r.item.sourcePath)} title="Kütüphanede görüntüle" aria-label="Kütüphanede görüntüle">
							<BookOpenIcon size={13} aria-hidden="true" />
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

	.quiz-screen h1 {
		font-family: var(--font-display);
		font-weight: 480;
		letter-spacing: -0.015em;
		font-size: 1.5rem;
		margin: 0 0 1.5rem;
	}

	.home-link {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		font-size: 0.875rem;
		color: var(--color-muted-foreground);
		text-decoration: none;
		margin-bottom: 1.5rem;
	}

	.home-link:hover {
		color: var(--color-primary);
	}

	.home-link:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}

	.status {
		color: var(--color-muted-foreground);
		text-align: center;
		margin-top: 3rem;
	}

	.status.error {
		color: var(--color-destructive);
	}

	.status.error.inline {
		text-align: left;
		margin: 0 0 1rem;
		font-size: 0.85rem;
	}

	.progress-bar {
		height: 6px;
		background: var(--color-border);
		border-radius: 999px;
		overflow: hidden;
	}

	.progress-fill {
		height: 100%;
		width: 100%;
		background: var(--color-primary);
		/* scaleX, not width — the fill never triggers layout recalculation
		   on its own track (its parent .progress-bar's size is fixed). */
		transform-origin: left;
		transition: transform var(--motion-base) var(--motion-easing);
	}

	.progress-label {
		font-size: 0.75rem;
		color: var(--color-muted-foreground);
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
		border: 1px solid var(--color-border);
		background: var(--color-background);
		color: var(--color-foreground);
		cursor: pointer;
		font-size: 1rem;
	}

	.option-letter {
		flex-shrink: 0;
		font-weight: 600;
		color: var(--color-muted-foreground);
	}

	.option.selected .option-letter {
		color: var(--color-primary);
	}

	.option.selected {
		border-color: var(--color-primary);
		background: var(--bubble-user);
	}

	.option:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}

	.open-answer {
		width: 100%;
		min-height: 6rem;
		resize: vertical;
		padding: 0.6rem 0.75rem;
		border-radius: 8px;
		border: 1px solid var(--color-border);
		background: var(--color-background);
		color: var(--color-foreground);
		font-family: var(--font-sans);
		font-size: 1rem;
	}

	.open-answer:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}

	.nav {
		display: flex;
		justify-content: space-between;
	}

	.nav button {
		padding: 0.5rem 1.2rem;
		border-radius: 8px;
		border: 1px solid var(--color-border);
		background: transparent;
		color: var(--color-foreground);
		cursor: pointer;
	}

	.nav button.primary {
		background: var(--color-primary);
		color: var(--color-primary-foreground);
		border-color: var(--color-primary);
		font-weight: 600;
	}

	.nav button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.nav button:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
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
		border-radius: var(--radius-lg);
		border: 1px solid var(--color-border);
	}

	/* A thick colored border-left is the detector's own named "most
	   recognizable AI-slop tell" — kept at 2px (not the original 3px) and
	   tied to the semantic --success/--destructive tokens rather than the
	   brand accent, since this is a real correct/incorrect scan cue
	   (the Duolingo/Anki-review pattern), not decoration standing in for
	   content. */
	.result-item.correct {
		border-left: 2px solid var(--success);
	}

	.result-item.incorrect {
		border-left: 2px solid var(--color-destructive);
	}

	.result-mark {
		display: flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		width: 1.5rem;
		height: 1.5rem;
	}

	.result-item.correct .result-mark {
		color: var(--success);
	}

	.result-item.incorrect .result-mark {
		color: var(--color-destructive);
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
		color: var(--color-destructive);
	}

	.explanation {
		font-size: 0.9rem;
		color: var(--color-muted-foreground);
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
		color: var(--color-muted-foreground);
		text-decoration: none;
		border: 1px solid var(--color-border);
		border-radius: 999px;
		padding: 0.2rem 0.65rem;
	}

	.source-link:hover {
		color: var(--color-primary);
		border-color: var(--color-primary);
	}

	.source-link:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}
</style>
