<script lang="ts">
	import '../app.css';
	import 'katex/dist/katex.min.css';
	import { settings } from '$lib/settings.svelte';

	let { children } = $props();

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

{@render children()}
