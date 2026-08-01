<script lang="ts">
	import '../app.css';
	import 'katex/dist/katex.min.css';
	import { goto } from '$app/navigation';
	import { settings } from '$lib/settings.svelte';
	import { quizGeneration, dismissQuizGeneration } from '$lib/quiz-generation.svelte';
	import { cardGeneration, dismissCardGeneration } from '$lib/card-generation.svelte';
	import { reportGeneration, dismissReportGeneration } from '$lib/report-generation.svelte';
	import { mindmapGeneration, dismissMindMapGeneration } from '$lib/mindmap-generation.svelte';
	import { slidesGeneration, dismissSlidesGeneration } from '$lib/slides-generation.svelte';
	import GenerationStatusToast from '$lib/components/GenerationStatusToast.svelte';
	import OllamaStatusBanner from '$lib/components/OllamaStatusBanner.svelte';

	let { children } = $props();

	const STAGE_LABELS: Record<string, string> = {
		retrieving: 'Kaynaklar aranıyor...',
		validating: 'Doğrulanıyor...',
		retrying: 'Doğrulama başarısız, tekrar deneniyor...'
	};

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
</script>

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

<GenerationStatusToast
	status={quizGeneration.status}
	stageLabels={{ ...STAGE_LABELS, generating: 'Sorular üretiliyor...' }}
	doneMessage="Test hazır — görüntülemek için tıkla"
	errorPrefix="Test oluşturulamadı: "
	stackIndex={0}
	onView={() => {
		if (quizGeneration.status.phase !== 'done') return;
		const quizId = quizGeneration.status.quizId;
		dismissQuizGeneration();
		goto(`/study/quiz/${quizId}`);
	}}
	onDismiss={dismissQuizGeneration}
/>

<GenerationStatusToast
	status={cardGeneration.status}
	stageLabels={{ ...STAGE_LABELS, generating: 'Kartlar üretiliyor...' }}
	doneMessage="Kartlar hazır — incelemek için tıkla"
	errorPrefix="Kartlar oluşturulamadı: "
	stackIndex={1}
	onView={() => {
		if (cardGeneration.status.phase !== 'done') return;
		dismissCardGeneration();
		goto('/study/cards');
	}}
	onDismiss={dismissCardGeneration}
/>

<GenerationStatusToast
	status={reportGeneration.status}
	stageLabels={{ ...STAGE_LABELS, generating: 'Rapor yazılıyor...' }}
	doneMessage="Rapor hazır — görüntülemek için tıkla"
	errorPrefix="Rapor oluşturulamadı: "
	stackIndex={2}
	onView={() => {
		if (reportGeneration.status.phase !== 'done') return;
		const reportId = reportGeneration.status.reportId;
		dismissReportGeneration();
		goto(`/study/report/${reportId}`);
	}}
	onDismiss={dismissReportGeneration}
/>

<GenerationStatusToast
	status={mindmapGeneration.status}
	stageLabels={{ ...STAGE_LABELS, generating: 'Harita çıkarılıyor...' }}
	doneMessage="Harita hazır — görüntülemek için tıkla"
	errorPrefix="Harita oluşturulamadı: "
	stackIndex={3}
	onView={() => {
		if (mindmapGeneration.status.phase !== 'done') return;
		const mindmapId = mindmapGeneration.status.mindmapId;
		dismissMindMapGeneration();
		goto(`/study/mindmap/${mindmapId}`);
	}}
	onDismiss={dismissMindMapGeneration}
/>

<GenerationStatusToast
	status={slidesGeneration.status}
	stageLabels={{ ...STAGE_LABELS, generating: 'Slaytlar üretiliyor...' }}
	doneMessage="Sunum hazır — görüntülemek için tıkla"
	errorPrefix="Sunum oluşturulamadı: "
	stackIndex={4}
	onView={() => {
		if (slidesGeneration.status.phase !== 'done') return;
		const slideDeckId = slidesGeneration.status.slideDeckId;
		dismissSlidesGeneration();
		goto(`/study/slides/${slideDeckId}`);
	}}
	onDismiss={dismissSlidesGeneration}
/>

<style>
	.app-shell {
		display: flex;
		flex-direction: column;
		height: 100%;
	}

	.app-content {
		flex: 1;
		min-height: 0;
	}
</style>
