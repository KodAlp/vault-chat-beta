import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, type Plugin } from 'vite';
import path from 'node:path';
import crypto from 'node:crypto';
import { dataDir } from './src/lib/server/env';
import { writeMcpEndpoint, removeMcpEndpoint } from './src/lib/server/mcp-endpoint';

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

/**
 * `npm run dev` side of the MCP endpoint discovery (the packaged app does the same from Rust, see
 * spawn_sidecar in src-tauri/src/lib.rs): mint a per-run MCP token, hand it to the SSR code in this same
 * process (VC_MCP_TOKEN -> env.ts mcpToken() -> hooks.server.ts's /api/mcp/* gate), and publish
 * DATA_DIR/mcp-endpoint.json once the port is known so the MCP stdio process can find this server.
 * The file is removed again on close/exit, but only if it is still ours (another dev server or the
 * desktop app may own it by then). Serve mode only: `vite build` has nothing to publish.
 */
function mcpEndpointPlugin(): Plugin {
	return {
		name: 'vault-chat-mcp-endpoint',
		apply: 'serve',
		configureServer(server) {
			const http = server.httpServer;
			if (!http) return;
			const token = crypto.randomBytes(32).toString('hex');
			process.env.VC_MCP_TOKEN = token;
			const dir = dataDir();
			const pid = process.pid;
			const publish = () => {
				const addr = http.address();
				if (!addr || typeof addr === 'string') return;
				writeMcpEndpoint(dir, {
					url: `http://127.0.0.1:${addr.port}`,
					mcpToken: token,
					pid,
					startedAt: new Date().toISOString()
				});
			};
			const cleanup = () => {
				removeMcpEndpoint(dir, pid, token);
			};
			if (http.listening) publish();
			else http.once('listening', publish);
			http.once('close', cleanup);
			process.once('exit', cleanup);
		}
	};
}

export default defineConfig({
	plugins: [tailwindcss(), sveltekit(), mcpEndpointPlugin()],
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
			// .claude/worktrees/ holds full repo copies (each with node_modules)
			// when parallel work sessions are open — watching them only costs
			// file handles and CPU, nothing there is ever part of this app.
			// Anchored to this project's own root: a bare '**/.claude/**' would also
			// match every file of a worktree that itself lives under .claude/.
			ignored: ['**/data/**', path.join(process.cwd(), '.claude', '**').replaceAll('\\', '/')]
		}
	},
	// Without this, Vite only discovered a client dependency (most often a
	// single @lucide/svelte icon) the first time a page or panel using it was
	// opened, re-bundled, and then FULL-RELOADED the page ("optimized
	// dependencies changed. reloading") — measured 4 reloads in 4 clicks on
	// a fresh cache. In the desktop dev window that read as the screen going
	// black and restarting whenever a not-yet-visited screen was opened.
	// Crawling every client source file up front finds them all at startup.
	optimizeDeps: {
		entries: [
			'src/routes/**/+*.{svelte,ts}',
			'src/lib/**/*.{svelte,ts}',
			'!src/**/*.test.ts',
			// A type-only declaration file aborts the whole scan (esbuild:
			// "The constant ... must be initialized"), silently bringing the
			// per-page reloads back.
			'!src/**/*.d.ts',
			'!src/**/+server.ts',
			'!src/**/*.server.ts',
			'!src/lib/server/**'
		]
	}
});
