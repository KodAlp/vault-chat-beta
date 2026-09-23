<script lang="ts">
	import { onMount } from 'svelte';
	import { fly } from 'svelte/transition';
	import { goto } from '$app/navigation';
	import { Button } from '$lib/components/ui/button';
	import { markWelcomeShown } from '$lib/welcome';
	import { t } from '$lib/i18n/index.svelte';

	// Auto-continue keeps this from becoming a click-through chore on every
	// launch; the button just lets an impatient user skip the wait instead
	// of forcing them to sit through it. Longer than the original 5s
	// (İ1, Aşama 8, 2026-09-23) now that there's real disclosure text to
	// read, not just a title/tagline — still skippable, this is an
	// informational notice, not a blocking consent gate like İ4/İ5's
	// checkboxes.
	const AUTO_CONTINUE_MS = 12000;

	function proceed() {
		markWelcomeShown();
		goto('/', { replaceState: true });
	}

	onMount(() => {
		const timer = setTimeout(proceed, AUTO_CONTINUE_MS);
		return () => clearTimeout(timer);
	});
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
<div class="flex h-full flex-col items-center justify-center gap-4 px-4 text-center">
	<h1 in:fly={{ y: 12, duration: 150 }} class="font-display text-3xl font-medium">
		{t('WelcomePage.title')}
	</h1>
	<p in:fly={{ y: 12, duration: 150, delay: 40 }} class="max-w-sm text-sm text-muted-foreground">
		{t('WelcomePage.tagline')}
	</p>
	<ul in:fly={{ y: 12, duration: 150, delay: 60 }} class="flex max-w-md flex-col gap-2 text-left text-xs text-muted-foreground">
		<li>{t('WelcomePage.note1')}</li>
		<li>{t('WelcomePage.note2')}</li>
		<li>{t('WelcomePage.note3')}</li>
	</ul>
	<div in:fly={{ y: 12, duration: 150, delay: 80 }}>
		<Button onclick={proceed}>{t('WelcomePage.continue')}</Button>
	</div>
</div>
