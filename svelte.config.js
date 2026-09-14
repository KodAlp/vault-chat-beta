import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),
	kit: {
		adapter: adapter(),
		// SvelteKit's own CSRF check (runtime/server/respond.js) compares the
		// Origin header byte-exactly against event.url.origin, runs only in
		// production, and runs BEFORE hooks.server.ts. Under adapter-node that
		// url.origin is `https://…` (see the protocol note in hooks.server.ts),
		// so every real browser form POST — the multipart file import in
		// api/import and api/import/batch — was rejected in the packaged app
		// with "Cross-site POST form submissions are forbidden", while
		// `npm run dev` was unaffected because the check is compiled out there.
		// '*' makes the generated server emit csrf_check_origin: false at build
		// time (kit's core/sync/write_server.js), leaving hooks.server.ts's
		// loopback-aware guard as the single check — it covers strictly more:
		// every state-changing method rather than only form content types,
		// plus a Host allowlist that also covers GET (DNS rebinding).
		csrf: { trustedOrigins: ['*'] }
	}
};

export default config;
