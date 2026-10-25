import { test, expect } from './fixtures';

/**
 * broken internal link scan: starting at the main pages, follow every same-origin <a href> (breadth
 * first, bounded) and require each target to load without an error status. API routes and file downloads
 * are skipped; pages are SPA-rendered, so each link is opened in the browser rather than fetched.
 */
test('internal links resolve', async ({ page, request }) => {
	test.setTimeout(180_000);
	const created = await request.post('/api/vaults', { data: { name: 'Link Vault' } });
	const vaultId = ((await created.json()) as { vault: { id: string } }).vault.id;
	const seeds = ['/?picker=1', `/vault/${vaultId}`, '/settings', '/settings/vaults', '/settings/library', '/settings/skills', '/settings/memory', '/settings/models', '/settings/providers', '/settings/embedding', '/settings/smalltalk', '/study/progress', '/study/cards'];
	const seen = new Set<string>();
	const queue = [...seeds];
	const broken: string[] = [];
	while (queue.length > 0 && seen.size < 60) {
		const url = queue.shift() as string;
		if (seen.has(url)) continue;
		seen.add(url);
		const res = await page.goto(url);
		await page.waitForLoadState('networkidle');
		const bad = !res || res.status() >= 400 || (await page.locator('h1:has-text("404")').count()) > 0;
		if (bad) broken.push(`${url} -> ${res?.status()}`);
		const hrefs = await page.$$eval('a[href]', (as) => as.map((a) => (a as HTMLAnchorElement).getAttribute('href') ?? ''));
		for (const h of hrefs) {
			if (!h.startsWith('/') || h.startsWith('//') || h.startsWith('/api/')) continue;
			const clean = h.split('#')[0];
			if (clean && !seen.has(clean)) queue.push(clean);
		}
	}
	expect(broken).toEqual([]);
});
