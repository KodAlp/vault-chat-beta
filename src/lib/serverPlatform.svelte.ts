/**
 * L4 — the server's process.platform, fetched once per page load for wording that differs per OS
 * (install hints, path placeholders). The server is always the same machine as the UI. Reuses the tiny
 * GET /api/system/secrets-protection endpoint instead of adding a route; null until it answers (or if it
 * fails) the WebView user agent is used instead (see platformFromUserAgent).
 */
let platform = $state<string | null>(null);
let started = false;

export function serverPlatform(): string | null {
	if (!started) {
		started = true;
		fetch('/api/system/secrets-protection')
			.then((res) => (res.ok ? res.json() : null))
			.then((body: { platform?: unknown } | null) => {
				if (body && typeof body.platform === 'string') platform = body.platform;
			})
			.catch(() => {
				started = false;
			});
	}
	// Until the server answers (or if it can't), guess from the WebView's user agent — the UI always runs
	// on the server's machine — so the Windows-only winget note isn't hidden on Windows by a slow fetch.
	return platform ?? platformFromUserAgent();
}

function platformFromUserAgent(): string | null {
	if (typeof navigator === 'undefined') return null;
	const ua = navigator.userAgent;
	if (/Windows/i.test(ua)) return 'win32';
	if (/Mac OS X|Macintosh/i.test(ua)) return 'darwin';
	if (/Linux|X11/i.test(ua)) return 'linux';
	return null;
}
