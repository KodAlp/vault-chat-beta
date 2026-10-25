<script lang="ts">
	import { onMount } from 'svelte';
	import { motionFly, MOTION } from '$lib/motion';
	import { goto } from '$app/navigation';
	import { isTauri } from '@tauri-apps/api/core';
	import { Button } from '$lib/components/ui/button';
	import { markWelcomeShown } from '$lib/welcome';
	import { localServerSetupDone } from '$lib/localServerSetup.svelte';
	import { t } from '$lib/i18n/index.svelte';

	// Auto-continue keeps this from becoming a click-through chore on every
	// launch; the button just lets an impatient user skip the wait instead
	// of forcing them to sit through it. Shortened back down from the 12s
	// the previous pass used — that value assumed note1–3 sat
	// inline as always-visible text needing time to read; now they're
	// collapsed behind the "Privacy & responsibility" <details>, so the
	// default view is just a title/tagline/button and 6s is plenty. Opening
	// the disclosure clears this timer (see onDetailsToggle) so a user who
	// actually digs in isn't yanked away mid-read.
	const AUTO_CONTINUE_MS = 6000;

	let timer: ReturnType<typeof setTimeout> | undefined;

	// The desktop build's very first launch continues into the
	// local-server setup wizard instead of the app itself; every later
	// launch (localServerSetupDone() true) and every plain-browser session
	// (isTauri() false — this page still shows there, but nothing about
	// local servers is meaningful outside the desktop shell) goes straight
	// to '/' exactly as before.
	function proceed() {
		markWelcomeShown();
		if (isTauri() && !localServerSetupDone()) {
			goto('/setup/local-server', { replaceState: true });
		} else {
			goto('/', { replaceState: true });
		}
	}

	onMount(() => {
		timer = setTimeout(proceed, AUTO_CONTINUE_MS);
		return () => clearTimeout(timer);
	});

	function onDetailsToggle(e: Event & { currentTarget: HTMLDetailsElement }) {
		if (e.currentTarget.open) clearTimeout(timer);
	}
</script>

<svelte:head>
	<title>{t('WelcomePage.title')}</title>
</svelte:head>

<!-- h-full, not min-h-[100dvh] — this renders inside +layout.svelte's
     .app-content (flex:1; overflow-y:auto), which can be shorter than the
     raw window when a status banner is showing. A dvh-sized child there
     overflows that container and centers itself in the overflow, not the
     visible area — on a dark theme (near-black --ground) that reads as a
     totally blank screen with the real content scrolled out of view. -->
<div class="vc-empty h-full justify-center">
	<!-- Chick's own entrance/idle animation lives entirely in the scoped
	     <style> below (plain CSS @keyframes, not motionFly) — it needs a
	     two-stage timeline (settle in, then bob forever) that Svelte's
	     one-shot `in:` transitions don't express. -->
	<div class="chick-wrap">
		<div class="chick-bob">
			<img src="/logo.png" alt="" class="chick-image" />
		</div>
		<div class="chick-shadow" aria-hidden="true"></div>
	</div>

	<h1 in:motionFly={{ y: 12, duration: MOTION.fast, delay: 40 }} class="text-display-hero" style="max-width: 14ch; margin: 0;">
		{t('WelcomePage.title')}
	</h1>
	<p
		in:motionFly={{ y: 12, duration: MOTION.fast, delay: 60 }}
		class="text-body"
		style="max-width: 44ch; margin: 0; color: var(--label-secondary);"
	>
		{t('WelcomePage.tagline')}
	</p>

	<div in:motionFly={{ y: 12, duration: MOTION.fast, delay: 80 }}>
		<Button size="lg" onclick={proceed}>{t('WelcomePage.continue')}</Button>
	</div>

	<!-- Same <details>/<summary> disclosure pattern as
	     settings/providers/+page.svelte's "manage models" — collapsed by
	     default so the first thing anyone sees is title/tagline/button, not
	     three paragraphs of legal-flavored disclosure text. -->
	<details
		in:motionFly={{ y: 12, duration: MOTION.fast, delay: 100 }}
		class="text-footnote max-w-md text-[var(--label-secondary)]"
		ontoggle={onDetailsToggle}
	>
		<summary class="cursor-pointer rounded-[var(--radius-sm)] underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)]">{t('WelcomePage.details')}</summary>
		<ul class="mt-2 flex flex-col gap-2 text-start">
			<li>{t('WelcomePage.note1')}</li>
			<li>{t('WelcomePage.note2')}</li>
			<li>{t('WelcomePage.note3')}</li>
		</ul>
	</details>
</div>

<style>
	.chick-wrap {
		display: flex;
		flex-direction: column;
		align-items: center;
		/* Settle in once, then hold (fill: both) — ease-out only, no
		   bounce/overshoot (DESIGN.md anti-pattern list). Falls back to the
		   same curve tokens.css's --motion-easing already carries, so this
		   still matches even if the custom property is ever unavailable. */
		animation: welcome-chick-enter 500ms var(--motion-easing, cubic-bezier(0.2, 0, 0, 1)) both;
	}

	.chick-bob {
		transform-origin: bottom center;
		/* Starts only after the enter animation above has settled. */
		animation: welcome-chick-bob 3s ease-in-out infinite alternate 500ms;
	}

	.chick-image {
		width: 140px;
		height: 140px;
		object-fit: contain;
	}

	.chick-shadow {
		width: 88px;
		height: 14px;
		margin-top: -4px;
		border-radius: var(--radius-pill);
		filter: blur(3px);
		/* color-mix against a foreground token (not a hardcoded black) so the
		   shadow reads correctly on both the light and dark ramps — see
		   tokens.css's --text (inverted per theme already). */
		background: color-mix(in oklch, var(--text) 60%, transparent);
		animation: welcome-chick-shadow 3s ease-in-out infinite alternate 500ms;
	}

	@keyframes welcome-chick-enter {
		from {
			opacity: 0;
			transform: translateY(16px) scale(0.9);
		}
		to {
			opacity: 1;
			transform: none;
		}
	}

	@keyframes welcome-chick-bob {
		from {
			transform: translateY(0) rotate(-1.5deg);
		}
		to {
			transform: translateY(-4px) rotate(1.5deg);
		}
	}

	@keyframes welcome-chick-shadow {
		from {
			transform: scaleX(1);
			opacity: 0.45;
		}
		to {
			transform: scaleX(0.88);
			opacity: 0.3;
		}
	}

	:global(:root[data-motion="reduce"]) .chick-wrap,
	:global(:root[data-motion="reduce"]) .chick-bob,
	:global(:root[data-motion="reduce"]) .chick-shadow {
		animation: none;
	}
</style>
