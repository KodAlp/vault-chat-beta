import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { createVaultViaMcp } from '#lib/server/vaults.js';
import { fail } from '#lib/server/app-error.js';
import { failFrom } from '#lib/server/mcp-import.js';

const MAX_NAME_CHARS = 100;

/** create_vault: a normal vault, already opened to MCP and marked createdVia 'mcp'. Returns the id the
 * other MCP tools take as `vault`. */
export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json().catch(() => null)) as { name?: unknown } | null;
	const name = typeof body?.name === 'string' ? body.name.trim() : '';
	if (!name) fail('VALIDATION_REQUIRED', { field: 'name' });
	if (name.length > MAX_NAME_CHARS) fail('VALIDATION_INVALID', { field: 'name' });
	try {
		const vault = createVaultViaMcp(name);
		return json({ id: vault.id, name: vault.name, mcpExposed: true, createdVia: 'mcp' });
	} catch (err) {
		failFrom(err);
	}
};
