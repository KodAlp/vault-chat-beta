import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

// src/lib/server/env.ts reads process.env directly (so it also works
// outside Vite, for mcp/), but Vite's own .env loading only ever
// populates $env/dynamic/private, never process.env. Bridge it here for
// dev/build — a shell-set var already in process.env always wins, same
// precedence Vite's own loadEnv uses (verified: this does not override).
// Deliberately not inside env.ts or hooks.server.ts — either would make
// `node build` from the repo root start silently honoring .env, which it
// doesn't today.
try {
	process.loadEnvFile();
} catch {
	// .env is optional
}

export default defineConfig({
	plugins: [tailwindcss(), sveltekit()],
	// Pin to IPv4 loopback explicitly. Vite's default host resolution picked
	// whichever address "localhost" resolved to first on this machine (IPv6
	// ::1), which some Windows setups (VPN/AV breaking IPv6 loopback) can't
	// reach even though the app is meant to be loopback-only either way.
	server: {
		host: '127.0.0.1',
		// data/ is runtime-written state (chats.db, providers.json, vaults.json,
		// logs, secrets) sitting inside the project root — none of it is ever
		// imported as a module, but Vite watches it by default, so every API
		// write was triggering a full browser reload ("page reload
		// data/providers.json") instead of just the intended API response.
		watch: {
			ignored: ['**/data/**']
		}
	}
});
