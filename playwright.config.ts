import { defineConfig } from '@playwright/test';

/**
 * #62 - e2e + accessibility suite. Run with `npm run test:e2e` (NOT part of `npm test`).
 * The dev server is started by e2e/serve.mjs against a throwaway DATA_DIR under the OS temp dir; no model
 * provider is ever contacted (tests never send chat messages or save real keys).
 * Needs a Playwright Chromium: `npx playwright install chromium` (not downloaded automatically).
 */
const port = process.env.E2E_PORT || '5185';

export default defineConfig({
	testDir: 'e2e',
	testMatch: '**/*.spec.ts',
	fullyParallel: false,
	workers: 1,
	timeout: 60_000,
	reporter: 'list',
	use: {
		baseURL: `http://127.0.0.1:${port}`,
		trace: 'retain-on-failure'
	},
	webServer: {
		command: 'node e2e/serve.mjs',
		url: `http://127.0.0.1:${port}/api/vaults`,
		reuseExistingServer: false,
		timeout: 120_000,
		stdout: 'pipe'
	}
});
