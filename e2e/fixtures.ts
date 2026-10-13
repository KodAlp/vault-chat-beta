import { test as base, expect } from '@playwright/test';

/** Skips the once-per-session welcome redirect so tests land on the page they ask for. */
export const test = base.extend({
	page: async ({ page }, use) => {
		await page.addInitScript(() => {
			try {
				sessionStorage.setItem('vault-chat-welcome-shown', '1');
			} catch {
				// ignore
			}
		});
		await use(page);
	}
});

export { expect };
