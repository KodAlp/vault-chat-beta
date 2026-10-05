// Applies the saved theme to <html data-theme> before the first paint.
//
// Without this, every full page load (dev-server reloads, the desktop
// window opening, a crash-recovery reload) showed app.html's no-JS fallback
// background until +layout.svelte's $effect ran — pure black (#000) on a
// Windows machine in dark mode, even when the chosen theme was cream or
// sand. That black flash is what made a reload read as "the screen went
// dark".
//
// A separate file rather than an inline <script>: the desktop build's CSP is
// `script-src 'self'`, which blocks inline scripts. Loaded synchronously in
// <head> (no defer/async) so it runs before the body paints. Mirrors
// settings.svelte.ts (STORAGE_KEY 'vault-chat-settings', theme values) and
// +layout.svelte's "system" resolution; +layout.svelte remains the source
// of truth once the app mounts, this only covers the gap before that.
(function () {
	var THEMES = { light: 1, dark: 1, cream: 1, sand: 1, forest: 1 };
	try {
		var raw = localStorage.getItem('vault-chat-settings');
		var theme = raw ? JSON.parse(raw).theme : 'system';
		if (!THEMES[theme]) {
			theme = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
		}
		document.documentElement.dataset.theme = theme;
	} catch (e) {
		// Storage blocked or corrupt: leave app.html's fallback in place.
	}
})();
