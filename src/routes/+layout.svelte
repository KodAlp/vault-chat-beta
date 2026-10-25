<script lang="ts">
	import '../app.css';
	import 'katex/dist/katex.min.css';
	import { onMount } from 'svelte';
	import { goto, onNavigate } from '$app/navigation';
	import { page } from '$app/state';
	import { isTauri } from '@tauri-apps/api/core';
	import { getCurrentWindow } from '@tauri-apps/api/window';
	import WindowTitleBar from '#lib/components/WindowTitleBar.svelte';
	import { settings } from '#lib/settings.svelte.js';
	import { welcomeAlreadyShown } from '#lib/welcome.js';
	import { quizGeneration, dismissQuizGeneration, cancelQuizGeneration } from '#lib/quiz-generation.svelte.js';
	import { cardGeneration, dismissCardGeneration, cancelCardGeneration } from '#lib/card-generation.svelte.js';
	import { reportGeneration, dismissReportGeneration, cancelReportGeneration } from '#lib/report-generation.svelte.js';
	import { mindmapGeneration, dismissMindMapGeneration, cancelMindMapGeneration } from '#lib/mindmap-generation.svelte.js';
	import { slidesGeneration, dismissSlidesGeneration, cancelSlidesGeneration } from '#lib/slides-generation.svelte.js';
	import GenerationStatusToast from '#lib/components/GenerationStatusToast.svelte';
	import ReindexDialog from '#lib/components/ReindexDialog.svelte';
	import LocalServerBanner from '#lib/components/LocalServerBanner.svelte';
	import PythonStatusBanner from '#lib/components/PythonStatusBanner.svelte';
	import { requestScopeExpand } from '#lib/scope-expand.svelte.js';
	import { handleExternalLinkClick } from '#lib/openExternalLink.js';
	import { i18n, t } from '#lib/i18n/index.svelte.js';
	import { localeInfo } from '#lib/i18n/locales.js';

	let { children } = $props();

	// One shared reindex dialog for every generation toast's
	// "Yeniden indeksle" action (EMBEDDING_MISMATCH); each store's status
	// entry already carries `vaultId`, so this just needs somewhere to open
	// against.
	let reindexVaultId = $state<string | null>(null);
	let reindexOpen = $state(false);
	function openReindex(vaultId: string | undefined) {
		if (!vaultId) return;
		reindexVaultId = vaultId;
		reindexOpen = true;
	}

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
	// data-theme is always a concrete theme name, never left unset ('system' → light/dark; cream/sand/forest are written as-is).
	let systemPrefersDark = $state(false);

	$effect(() => {
		const mql = window.matchMedia('(prefers-color-scheme: dark)');
		systemPrefersDark = mql.matches;
		const handler = (e: MediaQueryListEvent) => systemPrefersDark = e.matches;
		mql.addEventListener('change', handler);
		return () => mql.removeEventListener('change', handler);
	});

	$effect(() => {
		document.documentElement.dataset.theme = settings.theme === 'system' ? systemPrefersDark ? 'dark' : 'light' : settings.theme;
	});

	// Animation setting: 'on' → full, 'off' → reduce, 'system' → follow the OS's prefers-reduced-motion
	// (live listener, same pattern as the theme above). Written to <html data-motion> so every CSS rule and
	// the JS gates (motion.ts, thinking-chick.js) key off one attribute that the in-app setting can override.
	let systemReducesMotion = $state(false);

	$effect(() => {
		const mql = window.matchMedia('(prefers-reduced-motion: reduce)');
		systemReducesMotion = mql.matches;
		const handler = (e: MediaQueryListEvent) => systemReducesMotion = e.matches;
		mql.addEventListener('change', handler);
		return () => mql.removeEventListener('change', handler);
	});

	// <html lang/dir> follow the UI language: dir flips the whole layout for Arabic/Urdu (every physical
	// margin/padding in the app is logical for exactly this reason), lang selects the right font stack
	// (tokens.css :root[lang=...]) and CJK glyph variants, and lets screen readers pick the right voice.
	$effect(() => {
		const info = localeInfo(i18n.locale);
		document.documentElement.lang = info.code;
		document.documentElement.dir = info.dir;
	});

	$effect(() => {
		const reduce = settings.motion === 'off' || settings.motion !== 'on' && systemReducesMotion;
		document.documentElement.dataset.motion = reduce ? 'reduce' : 'full';
	});

	// Root-level, not +page.svelte's: "/" itself 307-redirects straight to
	// /vault/[id] server-side the moment a vault is active or there's only
	// one (see +page.server.ts's "son vault'u hatırlama" load) — for
	// exactly the common case this is meant to cover, +page.svelte never
	// mounts at all. The root layout wraps whatever route that redirect (or
	// any direct navigation) actually lands on, so this is the one place
	// guaranteed to run once per launch regardless of the landing route.
	onMount(() => {
		if (settings.showWelcomeScreen && page.url.pathname !== '/welcome' && !welcomeAlreadyShown()) {
			goto('/welcome', { replaceState: true });
		}
	});

	// Custom title bar (Windows desktop only — tauri.windows.conf.json turns the native decorations
	// off there) + F11 fullscreen. Set in onMount, not derived at init, so SSR and the first client
	// render agree (no bar) and the Tauri check only runs in the real window.
	let showTitleBar = $state(false);
	let fullscreen = $state(false);

	onMount(() => {
		if (!isTauri()) return;
		showTitleBar = (/Windows/i).test(navigator.userAgent);
		const win = getCurrentWindow();
		let disposed = false;
		let unlisten: (() => void) | undefined;
		const refreshFullscreen = () => {
			win
				.isFullscreen()
				.then((f) => {
					if (!disposed) fullscreen = f;
				})
				.catch(() => {});
		};
		refreshFullscreen();
		win
			.onResized(refreshFullscreen)
			.then((fn) => {
				if (disposed) fn();
				else unlisten = fn;
			})
			.catch(() => {});

		const onKeydown = async (e: KeyboardEvent) => {
			if (e.key === 'F11') {
				e.preventDefault();
				try {
					const next = !await win.isFullscreen();
					await win.setFullscreen(next);
					fullscreen = next;
				} catch {
					// Best-effort — a failed toggle just leaves the window as it was.
				}
			} else if (e.key === 'Escape' && !e.defaultPrevented && fullscreen) {
				// Only when nothing else (a dialog, a menu) already consumed the Escape.
				try {
					await win.setFullscreen(false);
					fullscreen = false;
				} catch {
					// see above
				}
			}
		};
		window.addEventListener('keydown', onKeydown);
		return () => {
			disposed = true;
			unlisten?.();
			window.removeEventListener('keydown', onKeydown);
		};
	});

	// Desktop dev builds only (`desktop:dev` loads the Vite devUrl directly,
	// no splash.html in front of it — see splash/index.html's own comment
	// and tauri.conf.json's "visible": false). Without this, the window
	// appears immediately, blank/white, for however long it takes this
	// route's JS to be fetched and Svelte to mount — exactly the "looks
	// stuck" flash reported after the welcome-screen timing pass. Two rAFs
	// (not one) because the first only guarantees layout has been
	// committed, not that the compositor has actually painted it — src-
	// tauri/src/lib.rs has a timed force-show fallback in case this JS path
	// never runs at all (a real bug, not just a slow one).
	onMount(() => {
		if (!isTauri()) return;
		requestAnimationFrame(() => {
			requestAnimationFrame(() => {
				getCurrentWindow().show();
			});
		});
	});

	// Native cross-fade between routes, not a bolted-on animation library —
	// startViewTransition is undefined in browsers/WebViews that don't
	// support it (onNavigate then just returns undefined, SvelteKit
	// navigates as it always did), and app.css's global
	// data-motion="reduce" override already collapses the
	// ::view-transition-* animation durations it drives, same as every
	// other animation in this app.
	//
	// /welcome's own two navigations (the automatic redirect into it right
	// after hydration, and its own automatic redirect back out ~1.8s later)
	// are excluded: those are the two navigations most likely to run before
	// the app has settled, on whatever WebView2 build happens to be
	// installed (Tauri doesn't pin one) — if a view transition there ever
	// glitches, the only thing visible underneath is dark theme's
	// near-black --ground, i.e. a "blank black screen" on literally the
	// first thing a user sees. Not worth the risk for a splash screen that
	// already animates its own content via svelte/transition.
	onNavigate((navigation) => {
		if (navigation.shallow && navigation.type === 'goto') return;
		if (navigation.from?.url.pathname === '/welcome' || navigation.to?.url.pathname === '/welcome') return;
		if (!document.startViewTransition) return;
		return new Promise((resolve) => {
			document.startViewTransition(async () => {
				resolve();
				await navigation.complete;
			});
		});
	});

	// Each store now holds an array of concurrent generations, not
	// one slot — so the fixed stackIndex={0..4} that used to give each
	// *type* its own vertical position no longer works (a type can have
	// 0, 1, or several active toasts at once). Cumulative bases keep every
	// visible toast, across all five types, at a distinct non-overlapping
	// position without changing the "quiz lane, then cards lane, then..."
	// ordering anyone using this app today is already used to.
	/** Every /study/* item route needs to know which vault it
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
<svelte:document onclick={handleExternalLinkClick}></svelte:document>

<!-- Column shell, not the banner rendered loose: LocalServerBanner (formerly OllamaStatusBanner) used to be
     position:fixed at the viewport top, which looked fine on scrolling pages
     but permanently covered the chat route's fixed-height header/icon-rail
     chrome (that route sizes itself to 100% of this wrapper, not the raw
     viewport, precisely so a banner pushing down from here reserves real
     space instead of overlapping it). -->
<div class="app-shell">
	{#if showTitleBar && !fullscreen}
		<WindowTitleBar />
	{/if}
	<LocalServerBanner />
	<PythonStatusBanner />
	<div class="app-content">
		{@render children()}
	</div>
</div>

{#each quizGeneration.items as status, i (status.id)}
	<GenerationStatusToast
		status={status}
		stageLabels={{
			...STAGE_LABELS,
			generating: t('GenerationLayout.quizGenerating')
		}}
		doneMessage={status.phase === 'done' && status.requested !== undefined && status.delivered !== undefined && status.delivered < status.requested
			? t('GenerationLayout.quizDoneShort', { delivered: status.delivered, requested: status.requested })
			: t('GenerationLayout.quizDone')}
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
		onCancel={() => cancelQuizGeneration(status.id)}
		onExpandScope={requestScopeExpand}
		onReindex={() => openReindex(status.vaultId)}
	/>
{/each}

{#each cardGeneration.items as status, i (status.id)}
	<GenerationStatusToast
		status={status}
		stageLabels={{
			...STAGE_LABELS,
			generating: t('GenerationLayout.cardsGenerating')
		}}
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
		onCancel={() => cancelCardGeneration(status.id)}
		onExpandScope={requestScopeExpand}
		onReindex={() => openReindex(status.vaultId)}
	/>
{/each}

{#each reportGeneration.items as status, i (status.id)}
	<GenerationStatusToast
		status={status}
		stageLabels={{
			...STAGE_LABELS,
			generating: t('GenerationLayout.reportGenerating')
		}}
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
		onCancel={() => cancelReportGeneration(status.id)}
		onExpandScope={requestScopeExpand}
		onReindex={() => openReindex(status.vaultId)}
	/>
{/each}

{#each mindmapGeneration.items as status, i (status.id)}
	<GenerationStatusToast
		status={status}
		stageLabels={{
			...STAGE_LABELS,
			generating: t('GenerationLayout.mindmapGenerating')
		}}
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
		onCancel={() => cancelMindMapGeneration(status.id)}
		onExpandScope={requestScopeExpand}
		onReindex={() => openReindex(status.vaultId)}
	/>
{/each}

{#each slidesGeneration.items as status, i (status.id)}
	<GenerationStatusToast
		status={status}
		stageLabels={{
			...STAGE_LABELS,
			generating: t('GenerationLayout.slidesGenerating')
		}}
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
		onCancel={() => cancelSlidesGeneration(status.id)}
		onExpandScope={requestScopeExpand}
		onReindex={() => openReindex(status.vaultId)}
	/>
{/each}

{#if reindexVaultId}
	<ReindexDialog vaultId={reindexVaultId} bind:open={reindexOpen} />
{/if}

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
