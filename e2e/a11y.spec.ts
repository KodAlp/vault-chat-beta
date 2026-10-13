import { createRequire } from 'node:module';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';

/**
 * #62 - axe-core scan of the main routes (WCAG 2.x A/AA tags), light and dark theme. Violations fail the
 * test with a readable list. axe is injected from node_modules, so no extra Playwright package is needed.
 */
const require = createRequire(import.meta.url);
const AXE_PATH = require.resolve('axe-core/axe.min.js');

interface AxeNode { target: unknown[]; html: string }
interface AxeViolation { id: string; impact: string | null; help: string; nodes: AxeNode[] }

async function scan(page: Page): Promise<string[]> {
	await page.addScriptTag({ path: AXE_PATH });
	const violations = await page.evaluate(async () => {
		// @ts-expect-error axe is injected at runtime
		const r = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } });
		return r.violations;
	});
	return (violations as AxeViolation[]).map(
		(v) => `[${v.impact}] ${v.id}: ${v.help}\n` + v.nodes.slice(0, 5).map((n) => `    ${n.target.join(' ')}  ${n.html.slice(0, 120)}`).join('\n')
	);
}

// Vite's dev server occasionally reloads a page once while it optimises dependencies on first visit; one retry
// absorbs that without hiding real violations (those fail again).
test.describe.configure({ retries: 1 });

let vaultId = '';

test.beforeAll(async ({ request }) => {
	const res = await request.post('/api/vaults', { data: { name: 'A11y Vault' } });
	expect(res.ok()).toBeTruthy();
	vaultId = ((await res.json()) as { vault: { id: string } }).vault.id;
});

const routes = (): [string, string][] => [
	['welcome', '/welcome'],
	['vault picker', '/?picker=1'],
	['vault home', `/vault/${vaultId}`],
	['new chat', `/vault/${vaultId}/chat/00000000-0000-4000-8000-000000000001`],
	['settings appearance', '/settings'],
	['settings vaults', '/settings/vaults'],
	['settings upload', '/settings/library'],
	['settings skills', '/settings/skills'],
	['settings memory', '/settings/memory'],
	['settings models', '/settings/models'],
	['settings providers', '/settings/providers'],
	['settings embedding', '/settings/embedding'],
	['settings smalltalk', '/settings/smalltalk'],
	['settings import (redirect)', '/settings/import'],
	['study progress', '/study/progress']
];

for (const scheme of ['light', 'dark'] as const) {
	test.describe(`axe ${scheme}`, () => {
		test.use({ colorScheme: scheme });
		for (const idx of routes().keys()) {
			test(`route ${idx}`, async ({ page }) => {
				const [name, url] = routes()[idx];
				test.info().annotations.push({ type: 'route', description: name });
				await page.goto(url);
				await page.waitForLoadState('networkidle');
				await page.waitForFunction(() => document.title.length > 0);
				await page.waitForTimeout(800);
				const found = await scan(page);
				expect(found, `${name} (${url})\n${found.join('\n')}`).toEqual([]);
			});
		}
	});
}
