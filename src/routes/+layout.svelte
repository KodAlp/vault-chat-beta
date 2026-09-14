<script lang="ts">
	import '../app.css';
	import 'katex/dist/katex.min.css';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { settings } from '$lib/settings.svelte';
	import { quizGeneration, dismissQuizGeneration } from '$lib/quiz-generation.svelte';
	import { cardGeneration, dismissCardGeneration } from '$lib/card-generation.svelte';
	import { reportGeneration, dismissReportGeneration } from '$lib/report-generation.svelte';
	import { mindmapGeneration, dismissMindMapGeneration } from '$lib/mindmap-generation.svelte';
	import { slidesGeneration, dismissSlidesGeneration } from '$lib/slides-generation.svelte';
	import GenerationStatusToast from '$lib/components/GenerationStatusToast.svelte';
	import OllamaStatusBanner from '$lib/components/OllamaStatusBanner.svelte';
	import { requestScopeExpand } from '$lib/scope-expand.svelte';
	import { handleExternalLinkClick } from '$lib/openExternalLink';
	import { t } from '$lib/i18n/index.svelte';

	let { children } = $props();

	// $derived, not a plain const — a bare object literal would call t() once
	// at module/component init and freeze at whatever locale was active then,
	// silently going stale if the user switches language later without a
	// full reload (see i18n/index.svelte.ts — i18n.locale is itself $state,
	// meant to be switchable live, same as settings.theme already is).
	let STAGE_LABELS = $derived<Record<string, string>>({
		retrieving: t('GenerationLayout.stageRetrieving'),
		validating: t('GenerationLayout.stageValidating'),
		retrying: t('GenerationLayout.stageRetrying')
	});

	// prefers-color-scheme reflects actual OS state and can't be overridden by
	// a manual in-app choice, so "system" is resolved here (with a live
	// listener for OS theme changes) rather than left to a CSS media query —
	// data-theme is always a concrete 'light'/'dark', never left unset.
	let systemPrefersDark = $state(false);

	$effect(() => {
		const mql = window.matchMedia('(prefers-color-scheme: dark)');
		systemPrefersDark = mql.matches;
		const handler = (e: MediaQueryListEvent) => (systemPrefersDark = e.matches);
		mql.addEventListener('change', handler);
		return () => mql.removeEventListener('change', handler);
	});

	$effect(() => {
		document.documentElement.dataset.theme =
			settings.theme === 'system' ? (systemPrefersDark ? 'dark' : 'light') : settings.theme;
	});

	// Faz 13: each store now holds an array of concurrent generations, not
	// one slot — so the fixed stackIndex={0..4} that used to give each
	// *type* its own vertical position no longer works (a type can have
	// 0, 1, or several active toasts at once). Cumulative bases keep every
	// visible toast, across all five types, at a distinct non-overlapping
	// position without changing the "quiz lane, then cards lane, then..."
	// ordering anyone using this app today is already used to.
	/** Faz 14: every /study/* item route needs to know which vault it
	 * belongs to (see study-db.ts's per-vault study.db) — status.vaultId
	 * (captured from the request that started this generation) makes that
	 * URL correct instead of silently falling back to "whatever vault is
	 * currently active", which breaks the moment that's not the vault the
	 * item was actually generated in. */
	/** from: wherever the user was when they clicked "view" on this toast
	 * (any page — a generation can finish while browsing elsewhere) — see
	 * back-link.ts. Without it, the study page's own back link had nothing
	 * to return to but a hardcoded home link. */
	function studyUrl(path: string, vaultId: string | undefined): string {
		const params = new URLSearchParams({ from: page.url.pathname + page.url.search });
		if (vaultId) params.set('vault', vaultId);
		return `${path}?${params.toString()}`;
	}

	let quizBase = $derived(0);
	let cardBase = $derived(quizBase + quizGeneration.items.length);
	let reportBase = $derived(cardBase + cardGeneration.items.length);
	let mindmapBase = $derived(reportBase + reportGeneration.items.length);
	let slidesBase = $derived(mindmapBase + mindmapGeneration.items.length);
</script>

<!-- Delegated app-wide, not per-page: renderMarkdown() output (chat bubbles,
     card/quiz/report/mindmap views) lands in several independent
     components, and this catches every external link click across all of
     them from one place — see openExternalLink.ts's own doc comment. -->
<svelte:document onclick={handleExternalLinkClick} />

<!-- Column shell, not the banner rendered loose: OllamaStatusBanner used to be
     position:fixed at the viewport top, which looked fine on scrolling pages
     but permanently covered the chat route's fixed-height header/icon-rail
     chrome (that route sizes itself to 100% of this wrapper, not the raw
     viewport, precisely so a banner pushing down from here reserves real
     space instead of overlapping it). -->
<div class="app-shell">
	<OllamaStatusBanner />
	<div class="app-content">
		{@render children()}
	</div>
</div>

{#each quizGeneration.items as status, i (status.id)}
	<GenerationStatusToast
		{status}
		stageLabels={{ ...STAGE_LABELS, generating: t('GenerationLayout.quizGenerating') }}
		doneMessage={t('GenerationLayout.quizDone')}
		errorPrefix={t('GenerationLayout.quizErrorPrefix')}
		stackIndex={quizBase + i}
		onView={() => {
			if (status.phase !== 'done') return;
			const quizId = status.quizId;
			const vaultId = status.vaultId;
			dismissQuizGeneration(status.id);
			goto(studyUrl(`/study/quiz/${quizId}`, vaultId));
		}}
		onDismiss={() => dismissQuizGeneration(status.id)}
		onExpandScope={requestScopeExpand}
	/>
{/each}

{#each cardGeneration.items as status, i (status.id)}
	<GenerationStatusToast
		{status}
		stageLabels={{ ...STAGE_LABELS, generating: t('GenerationLayout.cardsGenerating') }}
		doneMessage={t('GenerationLayout.cardsDone')}
		errorPrefix={t('GenerationLayout.cardsErrorPrefix')}
		stackIndex={cardBase + i}
		onView={() => {
			if (status.phase !== 'done') return;
			const vaultId = status.vaultId;
			dismissCardGeneration(status.id);
			goto(studyUrl('/study/cards', vaultId));
		}}
		onDismiss={() => dismissCardGeneration(status.id)}
		onExpandScope={requestScopeExpand}
	/>
{/each}

{#each reportGeneration.items as status, i (status.id)}
	<GenerationStatusToast
		{status}
		stageLabels={{ ...STAGE_LABELS, generating: t('GenerationLayout.reportGenerating') }}
		doneMessage={t('GenerationLayout.reportDone')}
		errorPrefix={t('GenerationLayout.reportErrorPrefix')}
		stackIndex={reportBase + i}
		onView={() => {
			if (status.phase !== 'done') return;
			const reportId = status.reportId;
			const vaultId = status.vaultId;
			dismissReportGeneration(status.id);
			goto(studyUrl(`/study/report/${reportId}`, vaultId));
		}}
		onDismiss={() => dismissReportGeneration(status.id)}
		onExpandScope={requestScopeExpand}
	/>
{/each}

{#each mindmapGeneration.items as status, i (status.id)}
	<GenerationStatusToast
		{status}
		stageLabels={{ ...STAGE_LABELS, generating: t('GenerationLayout.mindmapGenerating') }}
		doneMessage={t('GenerationLayout.mindmapDone')}
		errorPrefix={t('GenerationLayout.mindmapErrorPrefix')}
		stackIndex={mindmapBase + i}
		onView={() => {
			if (status.phase !== 'done') return;
			const mindmapId = status.mindmapId;
			const vaultId = status.vaultId;
			dismissMindMapGeneration(status.id);
			goto(studyUrl(`/study/mindmap/${mindmapId}`, vaultId));
		}}
		onDismiss={() => dismissMindMapGeneration(status.id)}
		onExpandScope={requestScopeExpand}
	/>
{/each}

{#each slidesGeneration.items as status, i (status.id)}
	<GenerationStatusToast
		{status}
		stageLabels={{ ...STAGE_LABELS, generating: t('GenerationLayout.slidesGenerating') }}
		doneMessage={t('GenerationLayout.slidesDone')}
		errorPrefix={t('GenerationLayout.slidesErrorPrefix')}
		stackIndex={slidesBase + i}
		onView={() => {
			if (status.phase !== 'done') return;
			const slideDeckId = status.slideDeckId;
			const vaultId = status.vaultId;
			dismissSlidesGeneration(status.id);
			goto(studyUrl(`/study/slides/${slideDeckId}`, vaultId));
		}}
		onDismiss={() => dismissSlidesGeneration(status.id)}
		onExpandScope={requestScopeExpand}
	/>
{/each}

<style>
	.app-shell {
		display: flex;
		flex-direction: column;
		height: 100%;
	}

	/* The app owns its scrolling; body/html must never be the scroll host.
	   Without this, a tall route (every /settings/* page, /library/view, the
	   study views) overflowed all the way out to <html> while body stayed
	   pinned at height:100% — which is the state that made bits-ui's body
	   scroll-lock visible as a white flash (see the html/body background note
	   in app.css). With the scroll container here, that lock is a visual
	   no-op. The chat route never showed the bug because its panels already
	   scroll themselves; it sizes to 100% of this box, so it does not gain a
	   second scrollbar from this. */
	.app-content {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
	}
</style>
