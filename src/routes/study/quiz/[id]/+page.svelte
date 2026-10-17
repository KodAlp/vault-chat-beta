<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { renderMarkdown } from '$lib/markdown';
	import { settings } from '$lib/settings.svelte';
	import { libraryViewerUrl } from '$lib/sourceLink';
	import { resolveBackHref } from '$lib/back-link';
	import { t } from '$lib/i18n/index.svelte';
	import { readResponseError, localizeError } from '$lib/server-error';
	import { scoreExcludingFlagged } from '$lib/study-answers';
	import type { PageProps } from './$types';
	import ExternalLinkIcon from '@lucide/svelte/icons/external-link';
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
	let notFound = $state(false);
	let quiz = $state<QuizView | null>(null);
	let items = $state<QuizItemView[]>([]);
	let attemptId = $state('');
	let currentIndex = $state(0);
	let answers = $state<Record<string, string>>({});
	let errorMessage = $state('');
	let result = $state<SubmitAttemptResponse | null>(null);
	let renderedResults = $state<
		{
			item: AttemptResultItem;
			questionHtml: string;
			explanationHtml: string;
			givenHtml: string;
			correctAnswerHtml: string;
			modelFeedbackHtml: string;
			/** Parallel to item.options — null for true_false/open, where
			 * AttemptResultItem.options is null too (only multiple_choice
			 * items carry options_json server-side). */
			optionsHtml: string[] | null;
		}[]
	>([]);

	let flagError = $state('');
	// The score with faulty-flagged questions out of numerator and denominator (a wrong answer key must not count against you).
	let adjusted = $derived(result ? scoreExcludingFlagged(renderedResults.map((r) => r.item)) : null);

	async function toggleFlag(r: (typeof renderedResults)[number]) {
		const next = !r.item.flagged;
		flagError = '';
		try {
			const res = await fetch(`/api/study/quizzes/${data.quizId}/items/${r.item.itemId}`, {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ vault: data.vaultId, flagged: next })
			});
			if (!res.ok) throw new Error();
			r.item.flagged = next;
		} catch {
			flagError = t('QuizStudyPage.flagFailed');
		}
	}

	let questionHtml = $state('');
	let optionsHtml = $state<string[]>([]);

	// `?vault=` (or an absent one) must round-trip exactly: appending an
	// EMPTY `vault=` param when data.vaultId is undefined would make
	// vaultFromUrl() try to resolve a vault literally named "" instead of
	// falling back to the active vault (its `id ?? getActiveVaultId()`
	// only falls back on null/undefined, not on an empty string).
	let quizQuery = $derived(data.vaultId ? `?vault=${encodeURIComponent(data.vaultId)}` : '');
	// See back-link.ts — falls back to the vault's chat list, not "/", when
	// this page was opened directly (no `from`, e.g. a bookmark).
	let backHref = $derived(
		resolveBackHref(page.url.searchParams.get('from'), data.vaultId ? `/vault/${data.vaultId}` : '/')
	);
	let here = $derived(page.url.pathname + page.url.search);

	async function load() {
		phase = 'loading';
		notFound = false;
		errorMessage = '';
		try {
			const [quizRes, attemptRes] = await Promise.all([
				fetch(`/api/study/quizzes/${data.quizId}${quizQuery}`),
				fetch('/api/study/attempts', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ quizId: data.quizId, vault: data.vaultId })
				})
			]);
			const failed = !quizRes.ok ? quizRes : !attemptRes.ok ? attemptRes : null;
			if (failed) {
				if (failed.status === 404) {
					notFound = true;
				} else {
					errorMessage = await readResponseError(failed);
				}
				phase = 'error';
				return;
			}
			const quizData = (await quizRes.json()) as { quiz: QuizView; items: QuizItemView[] };
			const attemptData = (await attemptRes.json()) as { attemptId: string };
			quiz = quizData.quiz;
			items = quizData.items;
			attemptId = attemptData.attemptId;
			if (items.length === 0) {
				errorMessage = t('QuizStudyPage.noQuestions');
				phase = 'error';
			} else {
				phase = 'taking';
			}
		} catch (err) {
			errorMessage = localizeError({ message: err instanceof Error ? err.message : undefined });
			phase = 'error';
		}
	}

	onMount(load);

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

	// Task 7 — which way the keyed question-enter animation should offset
	// from: +1 (forward, from next()) slides in from the right (+8px), -1
	// (backward, from prev()) slides in from the left (-8px). Exposed to
	// CSS as --nav-dir rather than two mutually-exclusive classes since the
	// keyframe's translateX only needs the sign flipped, not a second rule.
	let navDirection = $state<1 | -1>(1);

	function next() {
		if (currentIndex < items.length - 1) {
			navDirection = 1;
			currentIndex++;
		}
	}

	function prev() {
		if (currentIndex > 0) {
			navDirection = -1;
			currentIndex--;
		}
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
					fastModel: settings.fastModel,
					fastProvider: settings.fastProvider,
					vault: data.vaultId
				})
			});
			if (!res.ok) throw new Error();
			result = (await res.json()) as SubmitAttemptResponse;
			// Formulas/variables in the answer/explanation/model-feedback text were
			// shown as raw "$...$" until this — only the question itself went
			// through renderMarkdown before. Math-heavy subjects (math, physics,
			// electronics) made the results screen unreadable for exactly the
			// items a student most needs to review.
			renderedResults = await Promise.all(
				result.items.map(async (item) => ({
					item,
					questionHtml: await renderMarkdown(item.question),
					explanationHtml: await renderMarkdown(item.explanation),
					givenHtml: item.given ? await renderMarkdown(item.given) : '',
					correctAnswerHtml: await renderMarkdown(item.correctAnswer),
					modelFeedbackHtml: item.modelFeedback ? await renderMarkdown(item.modelFeedback) : '',
					optionsHtml: item.options ? await Promise.all(item.options.map((o) => renderMarkdown(o))) : null
				}))
			);
			phase = 'results';
		} catch {
			// Back to 'taking', not the terminal 'error' phase — answers are
			// still in memory (never cleared) and the PATCH is safe to retry,
			// so a flaky network blip shouldn't cost the user a completed
			// attempt they'd otherwise have to redo from scratch.
			errorMessage = t('QuizStudyPage.submitFailed');
			phase = 'taking';
		}
	}
</script>

<svelte:head>
	<title>{quiz?.title ?? t('QuizStudyPage.defaultTitle')} — Vault Chat</title>
</svelte:head>

<div class="quiz-screen">
	<a class="home-link" href={backHref}><ArrowLeftIcon class="rtl-flip" size={16} strokeWidth={1.75} aria-hidden="true" /> {t('Common.geriDon')}</a>

	<!-- See study/report/[id]/+page.svelte for why every one of these view
	     routes gets a boundary: the phase is switched off 'loading' before its
	     subtree has rendered once, so a render-time throw leaves the DOM
	     frozen on "Yükleniyor..." with nothing explaining it. -->
	<svelte:boundary>
	{#if phase === 'loading'}
		<p class="status">{t('Common.yukleniyor')}</p>
	{:else if phase === 'error'}
		{#if notFound}
			<p class="status error" role="alert">{t('QuizStudyPage.notFoundTitle')}</p>
			<p class="status">{t('QuizStudyPage.notFoundBody')}</p>
		{:else}
			<p class="status error" role="alert">{errorMessage}</p>
			<div class="retry-row">
				<button type="button" class="vc-btn secondary" onclick={load}>{t('Common.yenidenDene')}</button>
			</div>
		{/if}
	{:else if phase === 'taking' || phase === 'submitting'}
		{@const item = items[currentIndex]}
		<h1>{quiz?.title ?? t('QuizStudyPage.defaultTitle')}</h1>
		<div class="vc-progress">
			<span style="width: 100%; transform: scaleX({(currentIndex + 1) / items.length})"></span>
		</div>
		<p class="progress-label">{currentIndex + 1} / {items.length}</p>

		{#key currentIndex}
			<div class="question-card" style="--nav-dir: {navDirection}">
				<div class="question markdown-body">{@html questionHtml}</div>

				{#if item.type === 'multiple_choice' && item.options}
					<div class="options" role="radiogroup" aria-label={quiz?.title ?? t('QuizStudyPage.defaultTitle')}>
						{#each item.options as option, i (option + '#' + i)}
							<button
								type="button"
								class="vc-option"
								role="radio"
								aria-checked={answers[item.id] === option}
								onclick={() => selectAnswer(option)}
							>
								<span class="key">{String.fromCharCode(65 + i)}</span>
								<span class="option-md">{@html optionsHtml[i] ?? option}</span>
							</button>
						{/each}
					</div>
				{:else if item.type === 'true_false'}
					<div class="options" role="radiogroup" aria-label={quiz?.title ?? t('QuizStudyPage.defaultTitle')}>
						<button type="button" class="vc-option" role="radio" aria-checked={answers[item.id] === 'true'} onclick={() => selectAnswer('true')}>
							<span class="key">A</span>
							{t('QuizStudyPage.true')}
						</button>
						<button type="button" class="vc-option" role="radio" aria-checked={answers[item.id] === 'false'} onclick={() => selectAnswer('false')}>
							<span class="key">B</span>
							{t('QuizStudyPage.false')}
						</button>
					</div>
				{:else}
					<textarea
						class="open-answer"
						bind:value={answers[item.id]}
						placeholder={t('QuizStudyPage.openAnswerPlaceholder')}
					></textarea>
				{/if}
			</div>
		{/key}

		{#if errorMessage}
			<p class="status error inline" role="alert">{errorMessage}</p>
		{/if}

		<div class="nav">
			<button class="vc-btn secondary" onclick={prev} disabled={currentIndex === 0 || phase === 'submitting'}>{t('QuizStudyPage.back')}</button>
			{#if currentIndex < items.length - 1}
				<button class="vc-btn primary" onclick={next} disabled={phase === 'submitting'}>{t('QuizStudyPage.next')}</button>
			{:else}
				<button class="vc-btn primary" onclick={finish} disabled={phase === 'submitting'}>
					{phase === 'submitting' ? t('QuizStudyPage.submitting') : t('QuizStudyPage.finish')}
				</button>
			{/if}
		</div>
	{:else if phase === 'results' && result}
		<div class="results-phase">
		<h1>{t('QuizStudyPage.resultTitle', { score: Math.round((adjusted?.score ?? result.score) * 100) })}</h1>
		{#if adjusted && adjusted.excluded > 0}
			<p class="score-note">{t('QuizStudyPage.scoreExcludingFlagged', { count: adjusted.excluded })}</p>
		{/if}
		{#if flagError}
			<p class="status error" role="alert">{flagError}</p>
		{/if}
		<div class="results">
			{#each renderedResults as r (r.item.itemId)}
				<div class="result-item" class:correct={r.item.isCorrect} class:incorrect={!r.item.isCorrect}>
					<div class="result-mark">
						{#if r.item.isCorrect}
							<CheckIcon size={20} strokeWidth={1.75} aria-hidden="true" />
							<span class="sr-only">{t('QuizStudyPage.true')}</span>
						{:else}
							<XIcon size={20} strokeWidth={1.75} aria-hidden="true" />
							<span class="sr-only">{t('QuizStudyPage.false')}</span>
						{/if}
					</div>
					<div class="result-body">
						<div class="question markdown-body">{@html r.questionHtml}</div>

						{#if r.item.type === 'multiple_choice' && r.item.options}
							<!-- Options weren't shown at all before — a multiple-choice
							     result was unreadable without them. given/correct are
							     marked directly on the option instead of repeating them
							     as separate text below. -->
							<div class="options result-options">
								{#each r.item.options as option, i (option + '#' + i)}
									<div
										class="vc-option static"
										class:correct={option === r.item.correctAnswer}
										class:wrong={option === r.item.given && option !== r.item.correctAnswer}
									>
										<span class="key">{String.fromCharCode(65 + i)}</span>
										<span class="markdown-body option-md">{@html r.optionsHtml?.[i] ?? option}</span>
										{#if option === r.item.correctAnswer}
											<span class="verdict">{t('QuizStudyPage.true')}</span>
										{:else if option === r.item.given}
											<span class="verdict">{t('QuizStudyPage.false')}</span>
										{/if}
									</div>
								{/each}
							</div>
						{:else}
							<div class="answer-block">
								<span class="answer-label">{t('QuizStudyPage.yourAnswer')}</span>
								{#if r.item.given}
									<div class="markdown-body answer-md">{@html r.givenHtml}</div>
								{:else}
									<span class="answer-empty">{t('QuizStudyPage.emptyAnswer')}</span>
								{/if}
							</div>
							{#if !r.item.isCorrect}
								<div class="answer-block">
									<span class="answer-label">{t('QuizStudyPage.correctAnswer')}</span>
									<div class="markdown-body answer-md">{@html r.correctAnswerHtml}</div>
								</div>
							{/if}
						{/if}

						<div class="explanation markdown-body">{@html r.explanationHtml}</div>
						<div class="flag-row">
							<button type="button" class="flag-btn" onclick={() => toggleFlag(r)}>
								{r.item.flagged ? t('QuizStudyPage.unflag') : t('QuizStudyPage.flagItem')}
							</button>
							{#if r.item.flagged}
								<span class="flagged-note">{t('QuizStudyPage.flaggedNote')}</span>
							{/if}
						</div>
						{#if r.item.modelFeedback}
							<div class="model-feedback">
								<strong>{t('QuizStudyPage.modelFeedback')}</strong>
								<div class="markdown-body answer-md">{@html r.modelFeedbackHtml}</div>
							</div>
						{/if}
						<a
							class="source-link"
							href={libraryViewerUrl(r.item.sourcePath, data.vaultId ?? '', here, r.item.headingPath)}
							title={r.item.headingPath}
						>
							{r.item.sourcePath}
						</a>
						<a class="source-link" href={libraryViewerUrl(r.item.sourcePath, data.vaultId ?? '', here, r.item.headingPath)} title={t('Common.kaynagiAc')} aria-label={t('Common.kaynagiAc')}>
							<ExternalLinkIcon size={16} strokeWidth={1.75} aria-hidden="true" />
						</a>
					</div>
				</div>
			{/each}
		</div>
		</div>
	{/if}
	{#snippet failed(error)}
		<p class="status error" role="alert">
			{t('QuizStudyPage.viewFailed', { error: error instanceof Error ? error.message : String(error) })}
		</p>
	{/snippet}
	</svelte:boundary>
</div>

<style>
	.quiz-screen {
		max-width: 640px;
		margin: 0 auto;
		padding: var(--space-6) var(--space-4) var(--space-14);
	}

	.quiz-screen h1 {
		font: var(--text-display-title);
		margin: 0 0 var(--space-6);
	}

	.home-link {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		font: var(--text-subheadline);
		color: var(--label-secondary);
		text-decoration: none;
		margin-bottom: var(--space-6);
	}

	.home-link:hover {
		color: var(--label);
	}

	.home-link:focus-visible {
		outline: 2px solid var(--focus-ring);
		outline-offset: 2px;
	}

	.status {
		font: var(--text-body);
		color: var(--label-secondary);
		text-align: center;
		margin-top: 3rem;
	}

	.status.error {
		color: var(--danger);
	}

	.status.error.inline {
		text-align: start;
		margin: 0 0 1rem;
		font: var(--text-footnote);
	}

	.retry-row {
		display: flex;
		justify-content: center;
		margin-top: 1rem;
	}

	/* scaleX, not width — the fill never triggers layout recalculation on
	   its own track (its parent .vc-progress's size is fixed). */
	.vc-progress > span {
		transform-origin: left;
		transition: transform var(--motion-base) var(--motion-easing);
	}

	.progress-label {
		font: var(--text-footnote);
		color: var(--label-secondary);
		margin: 0.4rem 0 var(--space-6);
	}

	.question-card {
		margin-bottom: var(--space-6);
		/* Task 7 — keyed on currentIndex (see the {#key} wrapper in markup),
		   so this replays every time the question changes. --nav-dir (set
		   inline per-render) is +1 going forward, -1 going back, so the
		   offset direction actually matches which way the user navigated. */
		animation: question-enter var(--motion-base) var(--motion-easing);
	}

	@keyframes question-enter {
		from {
			opacity: 0;
			transform: translateX(calc(var(--nav-dir, 1) * 8px));
		}
		to {
			opacity: 1;
			transform: translateX(0);
		}
	}

	/* Task 7 — the results phase enters with an opacity-only fade. */
	.results-phase {
		animation: results-fade-in var(--motion-base) var(--motion-easing);
	}

	@keyframes results-fade-in {
		from {
			opacity: 0;
		}
		to {
			opacity: 1;
		}
	}

	.question {
		font: var(--text-body-reading);
		margin-bottom: var(--space-4);
	}

	.options {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}

	/* .vc-option from components.css; the taking-phase variant is a
	   <button role="radio"> so it needs its UA button chrome stripped. */
	button.vc-option {
		appearance: none;
		border: 0;
		width: 100%;
		text-align: start;
		color: var(--label);
		transition: background-color var(--motion-fast) var(--motion-easing);
	}

	button.vc-option:hover {
		background: var(--fill-hover);
	}

	button.vc-option:focus-visible {
		outline: 2px solid var(--focus-ring);
		outline-offset: 2px;
	}

	.vc-option :global(p) {
		margin: 0;
	}

	.open-answer {
		width: 100%;
		min-height: 6rem;
		resize: vertical;
		padding: var(--space-3);
		border-radius: var(--radius-md);
		border: 0;
		background: var(--fill-control);
		box-shadow: inset 0 0 0 1px var(--separator-strong);
		color: var(--label);
		font: var(--text-callout);
	}

	.open-answer::placeholder {
		color: var(--label-tertiary);
	}

	.open-answer:focus-visible {
		outline: none;
		box-shadow:
			inset 0 0 0 1px var(--border-control),
			0 0 0 2px var(--focus-ring);
	}

	.nav {
		display: flex;
		justify-content: space-between;
	}

	.nav .vc-btn:focus-visible {
		outline: 2px solid var(--focus-ring);
		outline-offset: 2px;
	}

	.results {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
	}

	.result-item {
		display: flex;
		gap: 0.75rem;
		padding: var(--space-4);
		border-radius: var(--radius-lg);
		background: var(--bg-elevated);
		box-shadow: inset 0 0 0 1px var(--separator);
	}

	/* Correct/incorrect is carried by the icon plus a visually-hidden
	   verdict word, not by the color alone. */
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
		color: var(--danger);
	}

	.result-body {
		flex: 1;
		min-width: 0;
	}

	/* Results-only variant of .vc-option: read-only (no hover/click
	   affordance), correct/wrong marked with a verdict word. */
	.result-options {
		margin: 0.4rem 0;
	}

	.vc-option.static {
		cursor: default;
		font: var(--text-subheadline);
		font-weight: 400;
	}

	.vc-option.static .option-md {
		min-width: 0;
	}

	.option-md :global(p) {
		margin: 0;
		display: inline;
	}

	.answer-block {
		display: flex;
		align-items: baseline;
		gap: 0.4rem;
		font: var(--text-subheadline);
		font-weight: 400;
		margin: 0.3rem 0;
	}

	.answer-label {
		flex-shrink: 0;
		color: var(--label-secondary);
	}

	.answer-empty {
		color: var(--label-secondary);
		font-style: italic;
	}

	.answer-md :global(p) {
		margin: 0;
		display: inline;
	}

	.explanation {
		font: var(--text-subheadline);
		font-weight: 400;
		color: var(--label-secondary);
		margin-top: 0.5rem;
	}

	.model-feedback {
		display: flex;
		align-items: baseline;
		gap: 0.4rem;
		font: var(--text-footnote);
		margin-top: 0.5rem;
	}

	.source-link {
		display: inline-block;
		margin-top: 0.6rem;
		font: var(--text-caption-1);
		color: var(--label-secondary);
		text-decoration: none;
		box-shadow: inset 0 0 0 1px var(--separator-strong);
		border-radius: var(--radius-full);
		padding: 0.2rem 0.65rem;
		overflow-wrap: anywhere;
		min-width: 0;
	}

	.source-link:hover {
		color: var(--label);
		background: var(--fill-hover);
	}

	.source-link:focus-visible {
		outline: 2px solid var(--focus-ring);
		outline-offset: 2px;
	}

	.score-note {
		margin: -1rem 0 1.25rem;
		font: var(--text-footnote);
		color: var(--label-secondary);
	}

	.flag-row {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 0.6rem;
		margin-top: 0.5rem;
		font: var(--text-footnote);
		color: var(--label-secondary);
	}

	.flag-btn {
		border: none;
		background: transparent;
		padding: 0;
		font: inherit;
		color: inherit;
		text-decoration: underline;
		text-underline-offset: 2px;
		cursor: pointer;
	}

	.flag-btn:focus-visible {
		outline: 2px solid var(--focus-ring);
		outline-offset: 2px;
	}
</style>
