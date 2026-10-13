import os from 'node:os';
import { test, expect } from './fixtures';

/**
 * #62 - key settings forms, English UI, isolated DATA_DIR (see e2e/serve.mjs). Serial: later tests build on
 * the vault the first one creates. No network calls to model providers, no real API keys.
 */
test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ request }) => {
	const res = await request.put('/api/ui-prefs', { data: { locale: 'en' } });
	expect(res.ok()).toBeTruthy();
});

test('create vault: empty name is blocked, a name creates and lists it', async ({ page }) => {
	await page.goto('/settings/vaults');
	const name = page.getByRole('textbox', { name: 'Vault name' });
	const create = page.getByRole('button', { name: 'Create', exact: true });
	await expect(name).toBeVisible();
	await expect(create).toBeDisabled();
	await name.fill('   ');
	await expect(create).toBeDisabled();
	await name.fill('E2E Vault');
	await expect(create).toBeEnabled();
	await create.click();
	await expect(page.getByText('E2E Vault', { exact: true })).toBeVisible();
	await expect(name).toHaveValue('');
});

test('rename vault: saving updates the name', async ({ page }) => {
	await page.goto('/settings/vaults');
	await page.getByRole('button', { name: 'Rename', exact: true }).first().click();
	const input = page.getByRole('textbox', { name: 'Rename' });
	await input.fill('E2E Vault Renamed');
	await input.press('Enter');
	await expect(page.getByText('E2E Vault Renamed').first()).toBeVisible();
	const res = await page.request.get('/api/vaults');
	const { vaults } = (await res.json()) as { vaults: { name: string }[] };
	expect(vaults.map((v) => v.name)).toContain('E2E Vault Renamed');
});

test('provider form: required fields, bad URL error, valid local provider is listed', async ({ page }) => {
	await page.goto('/settings/providers');
	await page.getByRole('button', { name: 'Add provider' }).click();
	const label = page.getByLabel('Name', { exact: true });
	const baseUrl = page.getByLabel('API endpoint (base URL)');
	const add = page.getByRole('button', { name: 'Add', exact: true });
	await expect(add).toBeDisabled();
	await label.fill('E2E Local');
	await expect(add).toBeDisabled();
	await baseUrl.fill('not a url');
	await expect(add).toBeEnabled();
	await add.click();
	await expect(page.getByRole('alert').filter({ hasText: 'valid http(s) address' })).toBeVisible();
	await baseUrl.fill('http://127.0.0.1:9/v1');
	await add.click();
	await expect(page.getByText('E2E Local').first()).toBeVisible();
	// the form closes on success and nothing was sent to any model server
	await expect(page.getByLabel('API endpoint (base URL)')).toHaveCount(0);
});

test('backup card: relative path and a path inside the vault folder are rejected', async ({ page }) => {
	await page.goto('/settings/vaults');
	const dest = page.getByLabel('Backup location');
	const start = page.getByRole('button', { name: 'Back up', exact: true });
	await expect(dest).not.toHaveValue('');
	await dest.fill('');
	await expect(start).toBeDisabled();

	await dest.fill('relative/backup/folder');
	await start.click();
	await expect(page.getByRole('alert').filter({ hasText: 'Enter a full folder path' })).toBeVisible();

	const { vaults } = (await (await page.request.get('/api/vaults')).json()) as { vaults: { path: string }[] };
	await dest.fill(vaults[0].path);
	await start.click();
	await expect(page.getByRole('alert').filter({ hasText: 'outside the app' })).toBeVisible();
});

test('MCP import folders: relative path rejected, existing folder added and removed', async ({ page }) => {
	await page.goto('/settings/vaults');
	const input = page.getByRole('textbox', { name: 'Absolute folder path' });
	const add = page.getByRole('button', { name: 'Add', exact: true }).last();
	await expect(page.getByText('No folders allowed')).toBeVisible();
	await expect(add).toBeDisabled();

	await input.fill('relative/folder');
	await add.click();
	await expect(page.getByRole('alert').filter({ hasText: 'invalid' })).toBeVisible();
	await expect(page.getByText('No folders allowed')).toBeVisible();

	await input.fill(os.tmpdir());
	await add.click();
	await expect(page.getByText('No folders allowed')).toHaveCount(0);
	const settings = (await (await page.request.get('/api/settings/mcp')).json()) as { allowedImportRoots: string[] };
	expect(settings.allowedImportRoots).toHaveLength(1);

	await page.getByRole('button', { name: /^Remove / }).first().click();
	await expect(page.getByText('No folders allowed')).toBeVisible();
});
